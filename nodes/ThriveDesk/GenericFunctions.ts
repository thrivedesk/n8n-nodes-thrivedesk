import type {
	IDataObject,
	IExecuteFunctions,
	IExecuteSingleFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

import { apiUrl as DEFAULT_BASE_URL } from '../../environment';

type ThriveDeskContext =
	| IExecuteFunctions
	| IExecuteSingleFunctions
	| ILoadOptionsFunctions
	| IHookFunctions
	| IWebhookFunctions;

/**
 * ThriveDesk answers a refused action with `{ "message": "<why>" }`. n8n would
 * otherwise title it with generic status-code text ("Forbidden - perhaps check
 * your credentials?"), which points at the credential when the real cause is a
 * business rule (reply ratio, quota, plan). Pull the API's own wording out so it
 * can be used as the error title.
 */
function apiErrorMessage(error: JsonObject): string | undefined {
	const data = (error.context as IDataObject | undefined)?.data as IDataObject | undefined;
	const causeError = (error.cause as IDataObject | undefined)?.error as IDataObject | undefined;
	const message = data?.message ?? causeError?.message ?? error.description;
	return typeof message === 'string' && message.trim() !== '' ? message.trim() : undefined;
}

/**
 * Resolve the API base URL from the credential, falling back to production.
 * The credential exposes an optional `baseUrl` override for staging.
 */
async function getBaseUrl(this: ThriveDeskContext): Promise<string> {
	const credentials = await this.getCredentials('thriveDeskOAuth2Api');
	const baseUrl = (credentials?.baseUrl as string | undefined)?.trim();
	return baseUrl && baseUrl.length > 0 ? baseUrl.replace(/\/$/, '') : DEFAULT_BASE_URL;
}

/**
 * Authenticated request against the ThriveDesk partner API. Used by loadOptions,
 * listSearch and the trigger node (the declarative action node uses `routing`).
 */
export async function thriveDeskApiRequest(
	this: ThriveDeskContext,
	method: IHttpRequestMethods,
	resource: string,
	body: IDataObject = {},
	qs: IDataObject = {},
): Promise<IDataObject> {
	const baseURL = await getBaseUrl.call(this);

	const options: IHttpRequestOptions = {
		method,
		url: `${baseURL}${resource}`,
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		body,
		qs,
		json: true,
	};

	if (Object.keys(body).length === 0) {
		delete options.body;
	}

	try {
		return await this.helpers.httpRequestWithAuthentication.call(
			this,
			'thriveDeskOAuth2Api',
			options,
		);
	} catch (error) {
		const apiError = error as JsonObject & { httpCode?: string };
		const apiMessage = apiErrorMessage(apiError);
		if (apiMessage) {
			// A fresh plain payload on purpose: NodeApiError's constructor returns the
			// argument untouched when it is already a NodeApiError, so re-wrapping the
			// caught error would keep the generic title.
			throw new NodeApiError(
				this.getNode(),
				{ message: apiMessage, httpCode: apiError.httpCode } as JsonObject,
				{ message: apiMessage, httpCode: apiError.httpCode },
			);
		}
		if (apiError.httpCode === '403') {
			throw new NodeApiError(this.getNode(), apiError, {
				message: 'Insufficient scope',
				description:
					'This ThriveDesk credential lacks the scope this endpoint needs. Reconnect the credential and grant the requested scopes.',
			});
		}
		if (apiError.httpCode === '401') {
			throw new NodeApiError(this.getNode(), apiError, {
				message: 'Authentication failed',
				description: 'Reconnect the ThriveDesk credential.',
			});
		}
		if (apiError.httpCode === '429') {
			throw new NodeApiError(this.getNode(), apiError, {
				message: 'Too many requests',
				description: 'ThriveDesk rate limit hit. Enable "Retry On Fail" with a wait between tries.',
			});
		}
		throw new NodeApiError(this.getNode(), apiError);
	}
}

/**
 * Page through a list endpoint until exhausted. ThriveDesk list responses use a
 * `data` array with `meta.current_page` / `meta.last_page`.
 */
export async function thriveDeskApiRequestAllItems(
	this: ThriveDeskContext,
	method: IHttpRequestMethods,
	resource: string,
	qs: IDataObject = {},
): Promise<IDataObject[]> {
	const returnData: IDataObject[] = [];
	let page = 1;
	let lastPage = 1;

	do {
		const response = await thriveDeskApiRequest.call(this, method, resource, {}, { ...qs, page });
		const items = (response.data ?? response) as IDataObject[];
		if (Array.isArray(items)) {
			returnData.push(...items);
		}
		const meta = response.meta as IDataObject | undefined;
		lastPage = Number(meta?.last_page ?? page);
		page += 1;
	} while (page <= lastPage);

	return returnData;
}
