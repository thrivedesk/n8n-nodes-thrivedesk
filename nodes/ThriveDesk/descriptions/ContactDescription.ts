import type {
	IDataObject,
	IExecuteSingleFunctions,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';
import { getManyFields, simplifyField } from './shared';

const R = 'contact';

// Writable contact columns. This is the intersection of Contact::$fillable and the
// actual `contacts` table: `phone` is in $fillable but has no column, so sending it
// makes the update blow up with "Unknown column 'phone' in 'field list'". Anything
// outside this list is silently dropped by ContactController::update().
const CONTACT_FIELDS: Array<{ name: string; displayName: string }> = [
	{ displayName: 'Address', name: 'address' },
	{ displayName: 'Company', name: 'company' },
	{ displayName: 'Job Title', name: 'job_title' },
	{ displayName: 'Name', name: 'name' },
	{ displayName: 'Notes', name: 'notes' },
	{ displayName: 'Website', name: 'website' },
];

function contactFieldOptions(extra: INodeProperties[] = []): INodeProperties[] {
	const base = CONTACT_FIELDS.map(({ displayName, name }) => ({
		displayName,
		name,
		type: 'string' as const,
		default: '',
		routing: { send: { type: 'body' as const, property: name } },
	}));
	return [...base, ...extra].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * "Create or Update" against an API with no upsert route.
 *
 * POST /contacts rejects a duplicate email (unique rule) and only ever persists
 * `email` — everything else is dropped by the controller. So: look the contact up
 * by email, create it first when missing, and let the routing request be the PATCH
 * that actually writes the fields. Same draft-then-send shape the reply uses.
 */
async function contactUpsert(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const email = (this.getNodeParameter('email') as string).trim();
	const fields = this.getNodeParameter('additionalFields', {}) as IDataObject;

	const found = (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'thriveDeskOAuth2Api',
		{
			method: 'GET',
			baseURL: requestOptions.baseURL,
			url: '/contacts',
			headers: { Accept: 'application/json' },
			qs: { q: email, with_orphan: true, per_page: 100 },
			json: true,
		},
	)) as IDataObject;

	const rows = (found.data ?? []) as IDataObject[];
	let contact = rows.find(
		(c) => String(c.email ?? '').toLowerCase() === email.toLowerCase(),
	);

	if (!contact) {
		const created = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'thriveDeskOAuth2Api',
			{
				method: 'POST',
				baseURL: requestOptions.baseURL,
				url: '/contacts',
				headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
				body: { email },
				json: true,
			},
		)) as IDataObject;
		contact = (created.contact ?? created.data ?? created) as IDataObject;
	}

	requestOptions.method = 'PATCH';
	requestOptions.url = `/contacts/${contact.id as string}`;
	requestOptions.body = { ...fields, email };
	return requestOptions;
}

const contactLocator: INodeProperties = {
	displayName: 'Contact',
	name: 'contactId',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The contact to operate on',
	displayOptions: { show: { resource: [R], operation: ['update', 'get'] } },
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchContacts', searchable: true },
		},
		{
			displayName: 'By ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. 12345',
		},
	],
};

export const contactOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		default: 'create',
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create a contact',
				description: 'Create a contact from an email address',
				routing: { request: { method: 'POST', url: '/contacts' } },
			},
			{
				name: 'Create or Update',
				value: 'upsert',
				action: 'Create or update a contact',
				description: 'Create a new record, or update the current one if it already exists (upsert)',
				routing: {
					send: { preSend: [contactUpsert] },
					// preSend rewrites this to PATCH /contacts/{id}.
					request: { method: 'POST', url: '/contacts' },
				},
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get a contact',
				routing: {
					request: { method: 'GET', url: '=/contacts/{{$parameter["contactId"]}}' },
					output: { postReceive: [{ type: 'rootProperty', properties: { property: 'data' } }] },
				},
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many contacts',
				routing: {
					// with_orphan mirrors Zapier's Find Contact: without it, contacts that
					// have no conversation in the caller's inboxes are invisible.
					request: { method: 'GET', url: '/contacts', qs: { with_orphan: true } },
					output: { postReceive: [{ type: 'rootProperty', properties: { property: 'data' } }] },
				},
			},
			{
				name: 'Update',
				value: 'update',
				action: 'Update a contact',
				routing: { request: { method: 'PATCH', url: '=/contacts/{{$parameter["contactId"]}}' } },
			},
		],
	},
];

export const contactFields: INodeProperties[] = [
	contactLocator,

	// ----- Create / Create or Update: email is the identity key -----
	{
		displayName: 'Email',
		name: 'email',
		type: 'string',
		placeholder: 'e.g. customer@example.com',
		required: true,
		default: '',
		description: 'Email address; the identity key used for upsert',
		displayOptions: { show: { resource: [R], operation: ['create', 'upsert'] } },
		routing: { send: { type: 'body', property: 'email' } },
	},
	{
		// Not offered on plain Create: POST /contacts persists only the email and
		// silently discards everything else. Use Create or Update to set details.
		displayName: 'Optional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: [R], operation: ['upsert', 'update'] } },
		options: contactFieldOptions([
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				default: '',
				placeholder: 'e.g. customer@example.com',
				description: 'Update the email address (Update operation only)',
				displayOptions: { show: { '/operation': ['update'] } },
				routing: { send: { type: 'body', property: 'email' } },
			},
		]),
	},

	// ----- Get Many -----
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { resource: [R], operation: ['getAll'] } },
		options: [
			{
				displayName: 'Inbox Name or ID',
				name: 'inbox',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getInboxes' },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				routing: { send: { type: 'query', property: 'inbox' } },
			},
			{
				displayName: 'Search',
				name: 'q',
				type: 'string',
				default: '',
				placeholder: 'e.g. jane or jane@example.com',
				description: 'Match against contact name or email address',
				routing: { send: { type: 'query', property: 'q' } },
			},
		],
	},
	...getManyFields(R, {
		limitParameter: 'per_page',
		continueExpression: '={{ $response.body.meta.current_page < $response.body.meta.last_page }}',
	}),
	simplifyField(R, ['get', 'getAll']),
];
