import type {
	IDataObject,
	IExecuteSingleFunctions,
	IHttpRequestOptions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodeProperties,
	NodeApiError,
} from 'n8n-workflow';
import { thriveDeskApiRequest } from '../GenericFunctions';
import { getManyFields, simplifyField } from './shared';

const R = 'conversation';

// ThriveDesk conversation statuses are Title-case on the wire
// (Conversation::STATUS_ACTIVE === 'Active'); lowercase values fail validation.
const STATUS_OPTIONS = [
	{ name: 'Active', value: 'Active' },
	{ name: 'Closed', value: 'Closed' },
	{ name: 'Pending', value: 'Pending' },
];

const PRIORITY_OPTIONS = [
	{ name: 'High', value: 'High' },
	{ name: 'Low', value: 'Low' },
	{ name: 'Medium', value: 'Medium' },
	{ name: 'Normal', value: 'Normal' },
];

/** Comma-separated or array input -> a clean string[] (or undefined when empty). */
function toEmailList(value: unknown): string[] | undefined {
	const list = Array.isArray(value)
		? value.map(String)
		: typeof value === 'string'
			? value.split(',')
			: [];
	const cleaned = list.map((s) => s.trim()).filter(Boolean);
	return cleaned.length > 0 ? cleaned : undefined;
}

// Sending a reply is two calls (mirrors the Make `sendReply` module): POST
// .../draft stages the message body, then POST .../reply sends that draft along
// with the status/assignee. The routed request is the draft call and the send
// runs in postReceive, so the send goes through thriveDeskApiRequest and its
// refusal reason (reply quota, outbound ratio, plan limits) reaches the user
// instead of n8n's generic "Forbidden - perhaps check your credentials?".
//
// The staged draft cannot be rolled back when the send is refused: the delete
// route is first-party only and answers 403 "This endpoint is not available to
// third-party applications". So say so in the error instead.
async function replyDraftBody(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const extra = this.getNodeParameter('replyAdditionalFields', {}) as IDataObject;

	const body: IDataObject = { message: this.getNodeParameter('message') as string };
	const cc = toEmailList(extra.cc);
	if (cc) body.cc = cc;
	const bcc = toEmailList(extra.bcc);
	if (bcc) body.bcc = bcc;

	requestOptions.body = body;
	return requestOptions;
}

async function replySendDraft(
	this: IExecuteSingleFunctions,
	_items: INodeExecutionData[],
	response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	const conversationId = this.getNodeParameter('conversationId', undefined, {
		extractValue: true,
	}) as string;

	const draft = (response.body ?? {}) as IDataObject;
	const draftId = (draft.draft_id ?? (draft.data as IDataObject | undefined)?.draft_id) as
		| string
		| undefined;

	const extra = this.getNodeParameter('replyAdditionalFields', {}) as IDataObject;
	const body: IDataObject = { status: this.getNodeParameter('status') as string };
	if (draftId) body.draft_id = draftId;
	if (extra.assigneeId) body.assign_to = extra.assigneeId;
	const cc = toEmailList(extra.cc);
	if (cc) body.cc = cc;
	const bcc = toEmailList(extra.bcc);
	if (bcc) body.bcc = bcc;

	try {
		const sent = await thriveDeskApiRequest.call(
			this,
			'POST',
			`/conversation/${conversationId}/reply`,
			body,
		);
		return [{ json: sent }];
	} catch (error) {
		const apiError = error as NodeApiError;
		apiError.description = [
			apiError.description,
			'ThriveDesk refused the send. The message is still saved as a draft on the conversation — open it in ThriveDesk to send or discard it.',
		]
			.filter(Boolean)
			.join(' ');
		throw apiError;
	}
}

// POST /inboxes/{id}/conversations validates `to` / `subject` / `message` / `status`
// as required and reads contact details from a nested `contact` object. Assembling
// the whole body here keeps it in one place instead of spreading nested-property
// routing across six fields.
async function conversationCreateBody(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const extra = this.getNodeParameter('additionalFields', {}) as IDataObject;

	const body: IDataObject = {
		to: this.getNodeParameter('to') as string,
		subject: this.getNodeParameter('subject') as string,
		message: this.getNodeParameter('message') as string,
		status: this.getNodeParameter('status') as string,
		is_draft: false,
	};

	if (extra.agent) body.agent = extra.agent;

	const tags = extra.tags as string[] | undefined;
	if (Array.isArray(tags) && tags.length > 0) body.tags = tags;

	const cc = toEmailList(extra.cc);
	if (cc) body.cc = cc;
	const bcc = toEmailList(extra.bcc);
	if (bcc) body.bcc = bcc;

	if (extra.contactName) body.contact = { name: extra.contactName };

	requestOptions.body = body;
	return requestOptions;
}

/**
 * Build the recursive `q` filter POST /search expects.
 * Shapes: ['Text', keyword] | ['Pair', attribute, value] | ['And', [ ...conditions ]].
 *
 * A `Pair` is only legal *inside* a group. SearchQueryBuilderService::parseFilters
 * takes its filter accumulator by reference and a top-level Pair overwrites that
 * array with a plain string, so the org-scope filter is gone by the time the
 * service array_merge()s it — a hard 500. Every non-empty filter set therefore
 * goes out wrapped in `And`, even when there is only one condition.
 */
function buildSearchQuery(filters: IDataObject): unknown[] {
	const conditions: unknown[][] = [];

	if (filters.keyword) conditions.push(['Text', String(filters.keyword)]);
	if (filters.status) conditions.push(['Pair', 'status', filters.status]);
	if (filters.priority) conditions.push(['Pair', 'priority', filters.priority]);
	if (filters.inboxId) conditions.push(['Pair', 'inbox_id', filters.inboxId]);
	if (filters.assignedTo) conditions.push(['Pair', 'assignable_id', filters.assignedTo]);
	// Quoted so an address with @ / . survives the Meilisearch filter expression.
	if (filters.contactEmail) {
		conditions.push(['Pair', 'contact_email', `"${String(filters.contactEmail).trim()}"`]);
	}
	// The search index stores tag IDs, so the tag dropdown's values map straight through.
	const tags = filters.tags as string[] | undefined;
	if (Array.isArray(tags)) tags.forEach((tag) => conditions.push(['Pair', 'tags', tag]));

	if (conditions.length === 0) return ['Text', ''];
	return ['And', conditions];
}

async function conversationSearchBody(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const filters = this.getNodeParameter('filters', {}) as IDataObject;
	requestOptions.body = { q: buildSearchQuery(filters) };
	return requestOptions;
}

// GET /conversation/{id} answers { conversation: {...}, events: [...] } — there is
// no `data` envelope, so pulling `data` out returned an empty item. Flatten the
// conversation to the top level and keep the thread under `events`, which the
// Simplify toggle (on by default) then strips.
async function extractConversation(
	this: IExecuteSingleFunctions,
	_items: INodeExecutionData[],
	response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	const body = (response.body ?? {}) as IDataObject;
	const conversation = (body.conversation ?? body.data ?? body) as IDataObject;
	return [{ json: body.events ? { ...conversation, events: body.events } : conversation }];
}

// POST /search answers { success, data: { conversations: <laravel paginator> } }.
async function extractSearchResults(
	this: IExecuteSingleFunctions,
	_items: INodeExecutionData[],
	response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	const body = response.body as IDataObject | undefined;
	const conversations = ((body?.data as IDataObject | undefined)?.conversations ??
		{}) as IDataObject;
	const rows = (conversations.data ?? []) as IDataObject[];
	return rows.map((json) => ({ json }));
}

// Resource locator reused by every operation that targets one conversation.
const conversationLocator: INodeProperties = {
	displayName: 'Conversation',
	name: 'conversationId',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The conversation to operate on',
	displayOptions: {
		show: {
			resource: [R],
			operation: ['reply', 'addNote', 'update', 'addTags', 'removeTags', 'get'],
		},
	},
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchConversations', searchable: true },
		},
		{
			displayName: 'By ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. 12345',
		},
	],
};

export const conversationOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		default: 'create',
		options: [
			{
				name: 'Add Note',
				value: 'addNote',
				action: 'Add a private note to a conversation',
				description: 'Add an internal note not visible to the contact',
				routing: {
					request: { method: 'POST', url: '=/conversation/{{$parameter["conversationId"]}}/note' },
				},
			},
			{
				name: 'Add Tag',
				value: 'addTags',
				action: 'Add a tag to a conversation',
				routing: {
					request: { method: 'POST', url: '=/conversation/{{$parameter["conversationId"]}}/tags' },
				},
			},
			{
				name: 'Create',
				value: 'create',
				action: 'Create a conversation',
				routing: {
					send: { preSend: [conversationCreateBody] },
					request: {
						method: 'POST',
						url: '=/inboxes/{{$parameter["inboxId"]}}/conversations',
					},
				},
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get a conversation',
				routing: {
					request: { method: 'GET', url: '=/conversation/{{$parameter["conversationId"]}}' },
					output: { postReceive: [extractConversation] },
				},
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many conversations',
				// There is no GET /conversations route; POST /search is the list endpoint
				// (same one the conversation picker uses) and it carries the filters.
				routing: {
					send: { preSend: [conversationSearchBody] },
					request: { method: 'POST', url: '/search' },
					output: { postReceive: [extractSearchResults] },
				},
			},
			{
				name: 'Remove Tag',
				value: 'removeTags',
				action: 'Remove a tag from a conversation',
				routing: {
					request: {
						method: 'DELETE',
						url: '=/conversation/{{$parameter["conversationId"]}}/tags',
					},
				},
			},
			{
				name: 'Reply',
				value: 'reply',
				action: 'Reply to a conversation',
				routing: {
					// Stage the draft here; postReceive sends it (and rolls it back on failure).
					send: { preSend: [replyDraftBody] },
					request: { method: 'POST', url: '=/conversation/{{$parameter["conversationId"]}}/draft' },
					output: { postReceive: [replySendDraft] },
				},
			},
			{
				name: 'Update',
				value: 'update',
				action: 'Update a conversation',
				routing: {
					request: { method: 'PATCH', url: '=/conversation/{{$parameter["conversationId"]}}' },
				},
			},
		],
	},
];

export const conversationFields: INodeProperties[] = [
	conversationLocator,

	// ----- Create -----
	{
		displayName: 'Inbox Name or ID',
		name: 'inboxId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getInboxes' },
		required: true,
		default: '',
		description:
			'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		displayOptions: { show: { resource: [R], operation: ['create'] } },
	},
	{
		displayName: 'Subject',
		name: 'subject',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Refund request',
		displayOptions: { show: { resource: [R], operation: ['create'] } },
	},
	{
		displayName: 'Contact Email',
		name: 'to',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. customer@example.com',
		description: 'Email address of the contact the conversation is with',
		displayOptions: { show: { resource: [R], operation: ['create'] } },
	},
	{
		displayName: 'Message',
		name: 'message',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		description: 'Body of the first message. HTML is supported.',
		displayOptions: { show: { resource: [R], operation: ['create'] } },
	},
	{
		// Required by the API, so it is a first-class field rather than an optional one.
		displayName: 'Status',
		name: 'status',
		type: 'options',
		required: true,
		default: 'Active',
		description: 'Status the new conversation starts in',
		options: STATUS_OPTIONS,
		displayOptions: { show: { resource: [R], operation: ['create'] } },
	},
	{
		displayName: 'Optional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: [R], operation: ['create'] } },
		options: [
			{
				displayName: 'Assignee Name or ID',
				name: 'agent',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getUsers' },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'BCC',
				name: 'bcc',
				type: 'string',
				default: '',
				placeholder: 'a@example.com, b@example.com',
				description: 'Comma-separated email addresses to BCC',
			},
			{
				displayName: 'CC',
				name: 'cc',
				type: 'string',
				default: '',
				placeholder: 'a@example.com, b@example.com',
				description: 'Comma-separated email addresses to CC',
			},
			{
				displayName: 'Contact Name',
				name: 'contactName',
				type: 'string',
				default: '',
				description: 'Name to set on the contact if it is created by this conversation',
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

	// ----- Reply -----
	{
		displayName: 'Message',
		name: 'message',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		description: 'Reply body sent to the contact. HTML is supported.',
		displayOptions: { show: { resource: [R], operation: ['reply'] } },
		// No routing.send: the draft step (operation preSend) consumes this and
		// posts it to .../draft; the /reply request carries only the draft_id.
	},
	{
		displayName: 'Status',
		name: 'status',
		type: 'options',
		required: true,
		default: 'Active',
		description: 'Conversation status to set when the reply is sent',
		options: STATUS_OPTIONS,
		displayOptions: { show: { resource: [R], operation: ['reply'] } },
		// No routing.send — the send step (postReceive) reads this and puts it on
		// the /reply body; the routed request here is the draft call.
	},
	{
		displayName: 'Additional Fields',
		name: 'replyAdditionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: [R], operation: ['reply'] } },
		options: [
			{
				displayName: 'Assignee Name or ID',
				name: 'assigneeId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getUsers' },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'BCC',
				name: 'bcc',
				type: 'string',
				default: '',
				placeholder: 'a@example.com, b@example.com',
				description: 'Comma-separated email addresses to BCC',
			},
			{
				displayName: 'CC',
				name: 'cc',
				type: 'string',
				default: '',
				placeholder: 'a@example.com, b@example.com',
				description: 'Comma-separated email addresses to CC',
			},
		],
	},

	// ----- Add Note -----
	{
		displayName: 'Note',
		name: 'message',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		description: 'Internal note, not visible to the contact',
		displayOptions: { show: { resource: [R], operation: ['addNote'] } },
		routing: { send: { type: 'body', property: 'message' } },
	},

	// ----- Update -----
	{
		displayName: 'Update Fields',
		name: 'updateFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: [R], operation: ['update'] } },
		options: [
			{
				displayName: 'Assignee Name or ID',
				name: 'assigneeId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getUsers' },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				routing: { send: { type: 'body', property: 'assign_to' } },
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				default: 'Active',
				options: STATUS_OPTIONS,
				routing: { send: { type: 'body', property: 'status' } },
			},
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				default: '',
				routing: { send: { type: 'body', property: 'subject' } },
			},
		],
	},

	// ----- Add / Remove Tag -----
	// Backend attaches/detaches one tag per call (body key `tag`), mirroring the
	// Make and Zapier "Add Tag" modules — hence a single-select, not multiOptions.
	{
		displayName: 'Tag Name or ID',
		name: 'tag',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getTags' },
		required: true,
		default: '',
		description:
			'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		displayOptions: { show: { resource: [R], operation: ['addTags', 'removeTags'] } },
		routing: { send: { type: 'body', property: 'tag' } },
	},

	// ----- Get Many filters -----
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: [R], operation: ['getAll'] } },
		options: [
			{
				displayName: 'Assignee Name or ID',
				name: 'assignedTo',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getUsers' },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Contact Email',
				name: 'contactEmail',
				type: 'string',
				default: '',
				placeholder: 'e.g. customer@example.com',
				description: 'Only conversations with this contact',
			},
			{
				displayName: 'Inbox Name or ID',
				name: 'inboxId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getInboxes' },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Keyword',
				name: 'keyword',
				type: 'string',
				default: '',
				description: 'Free-text search across subject, messages and ticket ID',
			},
			{
				displayName: 'Priority',
				name: 'priority',
				type: 'options',
				default: 'Normal',
				options: PRIORITY_OPTIONS,
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				default: 'Active',
				options: STATUS_OPTIONS,
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
	{
		displayName: 'Sort',
		name: 'sort',
		type: 'options',
		default: 'newest',
		description: 'Order the results are returned in',
		options: [
			{ name: 'Newest First', value: 'newest' },
			{ name: 'Oldest First', value: 'oldest' },
		],
		displayOptions: { show: { resource: [R], operation: ['getAll'] } },
		routing: { send: { type: 'query', property: 'sort' } },
	},
	...getManyFields(R, {
		limitParameter: 'per-page',
		// data.conversations is a Laravel paginator
		continueExpression:
			'={{ $response.body.data.conversations.current_page < $response.body.data.conversations.last_page }}',
	}),
	simplifyField(R, ['get', 'getAll']),
];
