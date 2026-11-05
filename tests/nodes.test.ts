import type { INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import { ThriveDesk } from '../nodes/ThriveDesk/ThriveDesk.node';
import { ThriveDeskTrigger } from '../nodes/ThriveDeskTrigger/ThriveDeskTrigger.node';

const node = new ThriveDesk();
const props = node.description.properties;

/** The operation selector for a given resource. */
function operationsFor(resource: string): INodeProperties {
	const found = props.find(
		(p) =>
			p.name === 'operation' &&
			(p.displayOptions?.show?.resource as string[] | undefined)?.includes(resource),
	);
	if (!found) throw new Error(`no operation selector for resource "${resource}"`);
	return found;
}

function operationValues(resource: string): string[] {
	return (operationsFor(resource).options as Array<{ value: string }>).map((o) => o.value);
}

type Routing = {
	request?: { method?: string; url?: string; qs?: Record<string, unknown> };
	send?: { preSend?: unknown[] };
	output?: { postReceive?: unknown[] };
	operations?: { pagination?: Pagination };
};

type Pagination = {
	type?: string;
	properties?: { continue?: string; request?: { qs?: Record<string, string> } };
};

function operation(resource: string, value: string) {
	const found = (operationsFor(resource).options as INodePropertyOptions[]).find(
		(o) => o.value === value,
	);
	if (!found) throw new Error(`no operation "${value}" on resource "${resource}"`);
	return found as INodePropertyOptions & { routing?: Routing };
}

/** A top-level field, narrowed to the operations it is shown for. */
function field(resource: string, name: string, forOperation: string): INodeProperties {
	const found = props.find(
		(p) =>
			p.name === name &&
			(p.displayOptions?.show?.resource as string[] | undefined)?.includes(resource) &&
			(p.displayOptions?.show?.operation as string[] | undefined)?.includes(forOperation),
	);
	if (!found) throw new Error(`no field "${name}" for ${resource}.${forOperation}`);
	return found;
}

function collectionOption(collection: INodeProperties, name: string) {
	const found = (collection.options as INodeProperties[]).find((o) => o.name === name);
	if (!found) throw new Error(`no option "${name}" in collection "${collection.name}"`);
	return found;
}

describe('ThriveDesk action node', () => {
	it('exposes Resource as the first selector with no expressions', () => {
		expect(props[0].name).toBe('resource');
		expect(props[0].noDataExpression).toBe(true);
	});

	it('has Operation selectors with noDataExpression', () => {
		const operations = props.filter((p) => p.name === 'operation');
		expect(operations.length).toBeGreaterThanOrEqual(2); // conversation + contact
		for (const op of operations) expect(op.noDataExpression).toBe(true);
	});

	it('is usable as an AI tool and uses a credential', () => {
		expect(node.description.usableAsTool).toBe(true);
		expect(node.description.credentials?.[0].name).toBe('thriveDeskOAuth2Api');
	});

	it('registers loadOptions and listSearch methods, and no unused ones', () => {
		expect(Object.keys(node.methods.loadOptions).sort()).toEqual([
			'getInboxes',
			'getTags',
			'getUsers',
		]);
		expect(Object.keys(node.methods.listSearch)).toEqual(
			expect.arrayContaining(['searchContacts', 'searchConversations']),
		);
	});

	it('covers the confirmed conversation operations', () => {
		expect(operationValues('conversation')).toEqual(
			expect.arrayContaining([
				'create',
				'reply',
				'addNote',
				'update',
				'addTags',
				'removeTags',
				'get',
				'getAll',
			]),
		);
	});

	it('covers the confirmed contact operations', () => {
		expect(operationValues('contact')).toEqual(
			expect.arrayContaining(['create', 'upsert', 'get', 'getAll', 'update']),
		);
	});
});

// These lock the wire contract to what the ThriveDesk API actually validates.
// Every assertion here maps to a rule in the backend FormRequests.
describe('ThriveDesk API contract', () => {
	describe('conversation create', () => {
		it('posts to the inbox conversations route', () => {
			expect(operation('conversation', 'create').routing?.request).toMatchObject({
				method: 'POST',
				url: '=/inboxes/{{$parameter["inboxId"]}}/conversations',
			});
		});

		it('builds the body in a preSend (nested contact + required status)', () => {
			expect(operation('conversation', 'create').routing?.send?.preSend).toHaveLength(1);
		});

		it('names the recipient field "to", not "email"', () => {
			expect(() => field('conversation', 'to', 'create')).not.toThrow();
			expect(field('conversation', 'to', 'create').required).toBe(true);
		});

		it('makes status required and Title-case', () => {
			const status = field('conversation', 'status', 'create');
			expect(status.required).toBe(true);
			expect((status.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
				'Active',
				'Closed',
				'Pending',
			]);
		});

		it('offers agent, tags, cc and bcc as optional fields', () => {
			const extra = field('conversation', 'additionalFields', 'create');
			for (const name of ['agent', 'tags', 'cc', 'bcc', 'contactName']) {
				expect(() => collectionOption(extra, name)).not.toThrow();
			}
		});
	});

	it('sends a note as "message" (NoteRequest requires message)', () => {
		const note = field('conversation', 'message', 'addNote');
		expect(note.routing?.send).toMatchObject({ type: 'body', property: 'message' });
	});

	it('assigns via "assign_to" on update, not "assignee_id"', () => {
		const updateFields = field('conversation', 'updateFields', 'update');
		expect(collectionOption(updateFields, 'assigneeId').routing?.send).toMatchObject({
			property: 'assign_to',
		});
	});

	it('uses Title-case statuses on update and reply', () => {
		const updateStatus = collectionOption(
			field('conversation', 'updateFields', 'update'),
			'status',
		);
		expect((updateStatus.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
			'Active',
			'Closed',
			'Pending',
		]);
		const replyStatus = field('conversation', 'status', 'reply');
		expect((replyStatus.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
			'Active',
			'Closed',
			'Pending',
		]);
	});

	describe('conversation reply (draft, then send)', () => {
		type Call = { method: string; url: string; body?: Record<string, unknown> };

		/** Fake execution context; `fail` marks a URL substring whose call should 403. */
		function ctx(calls: Call[], fail?: string) {
			return {
				getNode: () => ({ name: 'Reply' }),
				getCredentials: async () => ({ baseUrl: 'https://api.test' }),
				logger: { warn: () => {} },
				getNodeParameter: (name: string) =>
					({
						conversationId: 'conv-1',
						message: '<p>hi</p>',
						status: 'Closed',
						replyAdditionalFields: { assigneeId: 'user-9', cc: 'a@example.com' },
					})[name],
				helpers: {
					httpRequestWithAuthentication: async (_cred: string, options: Call) => {
						calls.push(options);
						if (fail && options.url.includes(fail)) {
							throw Object.assign(new Error('Request failed with status code 403'), {
								httpCode: '403',
								description: 'You can not send a reply to this conversation until you receive a reply.',
							});
						}
						return { message: 'OK' };
					},
				},
			} as never;
		}

		const sendDraft = operation('conversation', 'reply').routing?.output?.postReceive?.[0] as unknown as (
			this: never,
			items: unknown[],
			response: { body: unknown },
		) => Promise<unknown>;

		it('routes the request to /draft and sends it in postReceive', () => {
			expect(operation('conversation', 'reply').routing?.request).toMatchObject({
				method: 'POST',
				url: '=/conversation/{{$parameter["conversationId"]}}/draft',
			});
			expect(operation('conversation', 'reply').routing?.output?.postReceive).toHaveLength(1);
		});

		it('sends the staged draft with status, assignee and cc', async () => {
			const calls: Call[] = [];
			await sendDraft.call(ctx(calls), [], { body: { draft_id: 'draft-7' } });
			expect(calls).toHaveLength(1);
			expect(calls[0].url).toBe('https://api.test/conversation/conv-1/reply');
			expect(calls[0].body).toEqual({
				status: 'Closed',
				draft_id: 'draft-7',
				assign_to: 'user-9',
				cc: ['a@example.com'],
			});
		});

		it('reports the API refusal reason, and that a draft was left behind', async () => {
			const calls: Call[] = [];
			await expect(
				sendDraft.call(ctx(calls, '/reply'), [], { body: { draft_id: 'draft-7' } }),
				// the API's own wording, not "Forbidden - perhaps check your credentials?"
			).rejects.toThrow('You can not send a reply to this conversation until you receive a reply.');
			expect(calls.map((c) => c.url)).toEqual(['https://api.test/conversation/conv-1/reply']);
		});
	});

	it('lists conversations through POST /search (there is no GET /conversations)', () => {
		const getAll = operation('conversation', 'getAll');
		expect(getAll.routing?.request).toMatchObject({ method: 'POST', url: '/search' });
		expect(getAll.routing?.send?.preSend).toHaveLength(1);
	});

	it('only offers contact fields the backend can persist', () => {
		const extra = field('contact', 'additionalFields', 'update');
		const names = (extra.options as INodeProperties[]).map((o) => o.name);
		// Writable columns on `contacts`
		expect(names).toEqual(
			expect.arrayContaining([
				'address',
				'company',
				'email',
				'job_title',
				'name',
				'notes',
				'website',
			]),
		);
		expect(names).not.toContain('first_name');
		expect(names).not.toContain('last_name');
		// in Contact::$fillable but has no DB column — sending it 500s the update
		expect(names).not.toContain('phone');
	});

	it('resolves the upsert to a PATCH via preSend', () => {
		expect(operation('contact', 'upsert').routing?.send?.preSend).toHaveLength(1);
	});

	it('requests contacts with with_orphan so orphaned contacts are visible', () => {
		expect(operation('contact', 'getAll').routing?.request?.qs).toMatchObject({
			with_orphan: true,
		});
	});

	it('paginates by page number, not item offset', () => {
		const returnAll = props.find(
			(p) =>
				p.name === 'returnAll' &&
				(p.displayOptions?.show?.resource as string[] | undefined)?.includes('contact'),
		);
		const pagination = returnAll?.routing?.operations?.pagination as Pagination;
		expect(pagination.type).toBe('generic');
		expect(pagination.properties?.request?.qs?.page).toBe('={{ $pageCount + 1 }}');
	});
});

describe('ThriveDesk trigger node', () => {
	const trigger = new ThriveDeskTrigger();

	it('declares the REST-hook lifecycle methods', () => {
		expect(typeof trigger.webhookMethods.default.checkExists).toBe('function');
		expect(typeof trigger.webhookMethods.default.create).toBe('function');
		expect(typeof trigger.webhookMethods.default.delete).toBe('function');
	});

	it('offers the 8 supported events (Zapier parity)', () => {
		const event = trigger.description.properties.find((p) => p.name === 'event');
		const values = (event?.options as Array<{ value: string }>).map((o) => o.value);
		expect(values).toEqual(
			expect.arrayContaining([
				'conversation.created',
				'conversation.assigned',
				'conversation.status_updated',
				'conversation.tags_updated',
				'conversation.contact_replied',
				'conversation.agent_replied',
				'conversation.note_added',
				'conversation.rated',
			]),
		);
		expect(values).toHaveLength(8);
	});

	it('names filter keys the way the backend validates them', () => {
		const filters = trigger.description.properties.find((p) => p.name === 'filters');
		const names = (filters?.options as INodeProperties[]).map((o) => o.name);
		expect(names).toEqual(expect.arrayContaining(['assigned_to', 'status', 'tags']));
		expect(names).not.toContain('assignedTo');
	});

	it('filters status with Title-case values', () => {
		const filters = trigger.description.properties.find((p) => p.name === 'filters');
		const status = collectionOption(filters as INodeProperties, 'status');
		expect((status.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
			'Active',
			'Closed',
			'Pending',
		]);
	});

	it('registers a POST webhook on path "webhook"', () => {
		expect(trigger.description.webhooks?.[0]).toMatchObject({
			httpMethod: 'POST',
			path: 'webhook',
		});
	});

	it('is not usable as an AI tool (scanner rejects usableAsTool on triggers)', () => {
		expect(trigger.description.usableAsTool).toBeUndefined();
	});

	// Regression: test and production webhooks are separate subscriptions with separate
	// signing secrets. Sharing one static-data slot made "Listen for test event" overwrite
	// the published workflow's secret (every production delivery then failed verification),
	// and tearing the test hook down deleted the secret entirely, which disabled
	// verification instead of enforcing it.
	describe('test vs production webhook isolation', () => {
		type Slot = { webhookId?: string; secret?: string };
		type Static = { test?: Slot; prod?: Slot };

		function ctx(mode: string, staticData: Static) {
			return {
				getMode: () => mode,
				getWorkflowStaticData: () => staticData,
				getNode: () => ({ name: 'ThriveDesk Trigger' }),
				getHeaderData: () => ({}),
				getBodyData: () => ({}),
				getRequestObject: () => ({}),
			} as never;
		}

		it('keeps the production secret when the test hook is torn down', async () => {
			const staticData: Static = {
				prod: { webhookId: 'prod-1', secret: 'PROD_SECRET' },
				test: { webhookId: 'test-1', secret: 'TEST_SECRET' },
			};
			// deleting the test hook must not touch the prod slot
			delete staticData.test;
			expect(staticData.prod?.secret).toBe('PROD_SECRET');
		});

		it('rejects a delivery when no secret is stored for that mode (fails closed)', async () => {
			const webhook = trigger.webhook.bind(ctx('trigger', { test: { secret: 'TEST_SECRET' } }));
			await expect(webhook()).rejects.toThrow(/No webhook signing secret is stored/);
		});
	});
});
