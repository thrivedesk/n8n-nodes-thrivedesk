import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import {
	NodeConnectionTypes,
	NodeOperationError,
} from 'n8n-workflow';
import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';

import { webhookApiVersion } from '../../environment';
import { thriveDeskApiRequest } from '../ThriveDesk/GenericFunctions';
import { loadOptions } from '../ThriveDesk/methods';

const SUPPORTED_EVENTS = [
	{ name: 'Conversation Assigned', value: 'conversation.assigned' },
	{ name: 'Conversation Created', value: 'conversation.created' },
	{ name: 'Conversation Note Added', value: 'conversation.note_added' },
	{ name: 'Conversation Rated', value: 'conversation.rated' },
	{ name: 'Conversation Replied (by Agent)', value: 'conversation.agent_replied' },
	{ name: 'Conversation Replied (by Contact)', value: 'conversation.contact_replied' },
	{ name: 'Conversation Status Updated', value: 'conversation.status_updated' },
	{ name: 'Conversation Tags Updated', value: 'conversation.tags_updated' },
];

// ThriveDesk statuses are Title-case on the wire (Conversation::STATUS_ACTIVE === 'Active').
const STATUS_OPTIONS = [
	{ name: 'Active', value: 'Active' },
	{ name: 'Closed', value: 'Closed' },
	{ name: 'Pending', value: 'Pending' },
];

/**
 * The backend matches tag filters against tag *names* (the delivered payload
 * carries names), while the tag dropdown hands back IDs. Resolve before subscribing
 * — the same thing the Zapier app does in `resolveTagNames`.
 */
/**
 * Test and production webhooks are two independent subscriptions.
 *
 * `getNodeWebhookUrl` returns `/webhook-test/…` while you are listening for a test
 * event and `/webhook/…` once the workflow is published, and the backend keys a
 * subscription by its callback_url — so each gets its own id and its own signing
 * secret. Storing them under one pair of static-data keys let the test run clobber
 * the published run's secret: every production delivery then failed signature
 * verification, and after the test hook was torn down the secret was gone entirely,
 * which silently disabled verification altogether. Keep the two slots apart.
 */
function slotFor(mode: string): 'test' | 'prod' {
	return mode === 'manual' ? 'test' : 'prod';
}

function readSlot(data: IDataObject, mode: string): { webhookId?: string; secret?: string } {
	return (data[slotFor(mode)] as IDataObject | undefined) ?? {};
}

async function resolveTagNames(this: IHookFunctions, tagIds: string[]): Promise<string[]> {
	if (tagIds.length === 0) return [];
	const response = await thriveDeskApiRequest.call(
		this,
		'GET',
		'/settings/tags',
		{},
		{ per_page: 1000 },
	);
	const tags = ((response?.data ?? response) ?? []) as IDataObject[];
	return tagIds.map((id) => {
		const match = tags.find((tag) => String(tag.id) === String(id));
		return String(match?.name ?? id);
	});
}

export class ThriveDeskTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ThriveDesk Trigger',
		name: 'thriveDeskTrigger',
		icon: 'file:thrivedesk.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts a workflow on ThriveDesk conversation events',
		defaults: { name: 'ThriveDesk Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'thriveDeskOAuth2Api', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
				isFullPath: false,
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				required: true,
				default: 'conversation.created',
				options: SUPPORTED_EVENTS,
			},
			{
				// Required: the backend subscribes (and delivers) per inbox — one
				// webhook fires only for its inbox, there is no all-inboxes wildcard.
				displayName: 'Inbox Name or ID',
				name: 'inboxId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getInboxes' },
				required: true,
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				description:
						'Only fire when the event matches these filters. Assignee applies to Created and Assigned, status to Created and Status Updated, tags to Created and Tags Updated.',
				options: [
					{
						displayName: 'Assignee Name or ID',
						name: 'assigned_to',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getUsers' },
						default: '',
						description:
							'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					},
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						default: 'Active',
						options: STATUS_OPTIONS,
						description: 'Only events for conversations in this status',
					},
					{
						displayName: 'Tag Names or IDs',
						name: 'tags',
						type: 'multiOptions',
						typeOptions: { loadOptionsMethod: 'getTags' },
						default: [],
						description:
							'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					},
				],
			},
		],
	};

	methods = {
		loadOptions,
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				const existing = readSlot(data, this.getMode());
				if (!existing.webhookId) return false;
				const response = await thriveDeskApiRequest.call(this, 'GET', '/apps/n8n/webhooks');
				const list = (response?.data ?? response) as IDataObject[];
				if (!Array.isArray(list)) return false;
				return list.some((w) => String(w.id) === String(existing.webhookId));
			},

			async create(this: IHookFunctions): Promise<boolean> {
				// The backend registers an app's webhook routes per-tenant from its
				// installed apps, so POST /apps/n8n/webhooks only exists once the n8n
				// app is installed for the org — otherwise it 405s. Install here (not
				// only in the credential test, which n8n doesn't reliably fire after
				// OAuth) so subscribing always works. Install is idempotent (firstOrNew)
				// and forgets the installed-apps cache, so this request installs and the
				// subscribe request below sees the freshly-registered route.
				await thriveDeskApiRequest.call(this, 'POST', '/apps/n8n/install', { source: 'n8n' });

				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const event = this.getNodeParameter('event') as string;
				const inboxId = this.getNodeParameter('inboxId') as string;
				const filters = this.getNodeParameter('filters', {}) as IDataObject;
				const secret = randomBytes(32).toString('hex');

				const body: IDataObject = {
					event,
					callback_url: webhookUrl,
					secret,
					label: 'n8n',
					inbox_id: inboxId,
					// pin the payload contract this node was built against, so a later
					// backend default cannot silently reshape existing subscriptions
					api_version: webhookApiVersion,
				};

				const subscriptionFilters: IDataObject = {};
				if (filters.assigned_to) subscriptionFilters.assigned_to = filters.assigned_to;
				if (filters.status) subscriptionFilters.status = filters.status;
				const tagIds = (filters.tags ?? []) as string[];
				if (Array.isArray(tagIds) && tagIds.length > 0) {
					subscriptionFilters.tags = await resolveTagNames.call(this, tagIds);
				}
				if (Object.keys(subscriptionFilters).length > 0) body.filters = subscriptionFilters;

				const response = await thriveDeskApiRequest.call(
					this,
					'POST',
					'/apps/n8n/webhooks',
					body,
				);
				const created = (response?.data ?? response) as IDataObject;
				if (!created?.id) return false;

				const data = this.getWorkflowStaticData('node');
				data[slotFor(this.getMode())] = { webhookId: created.id as string, secret };
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				const slot = slotFor(this.getMode());
				const existing = readSlot(data, this.getMode());
				if (existing.webhookId) {
					try {
						await thriveDeskApiRequest.call(
							this,
							'DELETE',
							`/apps/n8n/webhooks/${existing.webhookId}`,
						);
					} catch (error) {
						// Idempotent: a missing/already-removed hook is fine, so unsubscribe
						// still succeeds — but log it rather than dropping it silently, or a
						// real failure (auth, network) looks identical to a no-op teardown.
						this.logger.warn(
							`ThriveDesk Trigger: failed to delete webhook ${existing.webhookId}: ${
								(error as Error).message
							}`,
						);
					}
					// only clears this slot, so tearing down a test hook cannot strip the
					// published hook's secret and leave deliveries unverified
					delete data[slot];
				}
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const headers = this.getHeaderData() as IDataObject;
		const body = this.getBodyData() as IDataObject;
		const data = this.getWorkflowStaticData('node');
		// the secret belonging to THIS webhook (test or production), never the other one
		const secret = readSlot(data, this.getMode()).secret;

		// Verify the HMAC signature so only genuine ThriveDesk deliveries pass.
		// Standard Webhooks scheme (matches ThriveDesk's Support\Webhook\Signature):
		// signed input is "{id}.{timestamp}.{body}" over the raw bytes shipped, the
		// digest is base64 of the raw HMAC-SHA256, and the header carries a "v1," prefix.
		//
		// Fail closed: no stored secret means we cannot prove the sender is ThriveDesk,
		// so the delivery is rejected rather than executed unverified.
		if (!secret) {
			throw new NodeOperationError(
				this.getNode(),
				'No webhook signing secret is stored for this trigger',
				{
					description:
						'Unpublish and publish the workflow again to re-register the webhook and issue a new signing secret.',
				},
			);
		}

		{
			const signature = (headers['x-td-webhook-signature'] as string) ?? '';
			const webhookId = (headers['x-td-webhook-id'] as string) ?? '';
			const timestamp = (headers['x-td-webhook-timestamp'] as string) ?? '';
			const rawBody =
				(req as unknown as { rawBody?: Buffer | string }).rawBody ?? JSON.stringify(body);
			const bodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
			const digest = createHmac('sha256', secret)
				.update(`${webhookId}.${timestamp}.${bodyString}`)
				.digest('base64');
			const expected = `v1,${digest}`;

			const valid =
				signature.length === expected.length &&
				timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

			if (!valid) {
				throw new NodeOperationError(
					this.getNode(),
					'Webhook signature verification failed',
					{ description: 'The X-TD-Webhook-Signature header did not match the stored secret.' },
				);
			}
		}

		// TD envelope: { id, api_version, event, timestamp, data }
		return { workflowData: [this.helpers.returnJsonArray(body)] };
	}
}
