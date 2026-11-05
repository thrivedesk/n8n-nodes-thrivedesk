import type {
	IDataObject,
	IExecuteSingleFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';

// Verbose nested fields stripped when "Simplify" is enabled (>10 fields rule, §1.5).
const HEAVY_FIELDS = ['threads', 'events', 'messages', 'custom_fields', 'attachments', 'meta'];

/**
 * postReceive helper: when the operation's `simplify` boolean is on, drop the
 * heavy nested fields so the node returns a compact, ≤10-field object.
 */
export async function simplifyResponse(
	this: IExecuteSingleFunctions,
	items: INodeExecutionData[],
): Promise<INodeExecutionData[]> {
	const simplify = this.getNodeParameter('simplify', false) as boolean;
	if (!simplify) return items;

	return items.map((item) => {
		const json = { ...(item.json as IDataObject) };
		for (const field of HEAVY_FIELDS) delete json[field];
		return { ...item, json };
	});
}

export type GetManyOptions = {
	/** Query parameter the API uses for page size (e.g. `per_page`, `per-page`). */
	limitParameter: string;
	/** Expression that is true while another page exists. */
	continueExpression: string;
	operation?: string;
};

/**
 * returnAll / limit pair for "Get Many" operations.
 *
 * Pagination is `generic`, not `offset`: ThriveDesk endpoints are Laravel
 * paginators keyed by a 1-based `page` number, whereas n8n's `offset` type
 * advances its parameter by item count (0, 50, 100 …). Feeding those to `page`
 * would jump to page 50 instead of page 2.
 */
export function getManyFields(
	resource: string,
	{ limitParameter, continueExpression, operation = 'getAll' }: GetManyOptions,
): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: { show: { resource: [resource], operation: [operation] } },
			routing: {
				send: { paginate: '={{ $value }}' },
				operations: {
					pagination: {
						type: 'generic',
						properties: {
							continue: continueExpression,
							request: { qs: { page: '={{ $pageCount + 1 }}' } },
						},
					},
				},
			},
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1, maxValue: 100 },
			description: 'Max number of results to return',
			displayOptions: {
				show: { resource: [resource], operation: [operation], returnAll: [false] },
			},
			routing: {
				send: { type: 'query', property: limitParameter, value: '={{ $value }}' },
				output: { maxResults: '={{ $value }}' },
			},
		},
	];
}

// Reusable "Simplify" boolean for read operations.
export function simplifyField(resource: string, operations: string[]): INodeProperties {
	return {
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description: 'Whether to return a simplified version of the response instead of the raw data',
		displayOptions: { show: { resource: [resource], operation: operations } },
		routing: { output: { postReceive: [simplifyResponse] } },
	};
}
