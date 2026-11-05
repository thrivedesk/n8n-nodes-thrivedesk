import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodePropertyOptions,
} from 'n8n-workflow';
import { thriveDeskApiRequest } from '../GenericFunctions';

function toOptions(items: IDataObject[], nameKey = 'name', valueKey = 'id'): INodePropertyOptions[] {
	return items
		.map((item) => ({
			name: String(item[nameKey] ?? item.title ?? item.email ?? item[valueKey]),
			value: item[valueKey] as string | number,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export const loadOptions = {
	async getInboxes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		const response = await thriveDeskApiRequest.call(this, 'GET', '/inboxes');
		return toOptions((response?.data ?? response) as IDataObject[]);
	},

	async getUsers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		// /settings/users returns { users: [...] } — not the usual { data: [...] }.
		const response = await thriveDeskApiRequest.call(this, 'GET', '/settings/users');
		const users = (response?.users ?? response?.data ?? []) as IDataObject[];
		return users
			.map((u) => {
				const fullName = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
				return {
					name: fullName || String(u.email ?? u.id),
					value: u.id as string | number,
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	},

	async getTags(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		// per_page high so all tags load (the list is global and unpaged in the UI).
		const response = await thriveDeskApiRequest.call(this, 'GET', '/settings/tags', {}, { per_page: 1000 });
		return toOptions((response?.data ?? response) as IDataObject[]);
	},

};

export const listSearch = {
	async searchContacts(
		this: ILoadOptionsFunctions,
		filter?: string,
	): Promise<INodeListSearchResult> {
		// with_orphan: without it the API hides contacts that have no conversation in
		// the caller's inboxes — they simply never show up in the picker.
		// `q` must be omitted when blank, not sent empty: Laravel's
		// ConvertEmptyStringsToNull turns `?q=` into null and the `string` rule then
		// 422s ("The q field must be a string") — which is what clearing the picker's
		// search box used to do.
		const query: IDataObject = { with_orphan: true, per_page: 100 };
		if (filter && filter.trim() !== '') query.q = filter.trim();

		const response = await thriveDeskApiRequest.call(this, 'GET', '/contacts', {}, query);
		const items = (response?.data ?? response) as IDataObject[];
		return {
			results: items.map((c) => ({
				name: String(c.name ?? c.email ?? c.id),
				value: c.id as string,
			})),
		};
	},

	async searchConversations(
		this: ILoadOptionsFunctions,
		filter?: string,
		paginationToken?: string,
	): Promise<INodeListSearchResult> {
		// Conversations are searched via POST /search (MeiliSearch-backed). The body
		// `q` is a recursive filter array: [] for "everything", or ['Text', keyword]
		// for a keyword match (see Make's buildConversationQuery). Results are nested
		// at data.conversations, a Laravel paginator (current_page / last_page).
		const page = paginationToken ? Number(paginationToken) : 1;
		const q = filter && filter.trim() !== '' ? ['Text', filter.trim()] : [];
		const response = await thriveDeskApiRequest.call(
			this,
			'POST',
			'/search',
			{ q },
			{ 'per-page': 50, sort: 'newest', page },
		);
		const conversations = ((response?.data as IDataObject | undefined)?.conversations ??
			{}) as IDataObject;
		const items = (conversations.data ?? []) as IDataObject[];
		const currentPage = Number(conversations.current_page ?? page);
		const lastPage = Number(conversations.last_page ?? currentPage);
		return {
			results: items.map((c) => {
				// Subjects repeat across tickets, so lead with the ticket number —
				// it is the only thing that tells two same-subject rows apart.
				const subject = String(c.subject ?? c.title ?? 'No subject');
				const ticket = c.ticket_id ?? c.id;
				return {
					name: ticket ? `#${ticket} — ${subject}` : subject,
					value: c.id as string,
				};
			}),
			paginationToken: currentPage < lastPage ? String(currentPage + 1) : undefined,
		};
	},
};
