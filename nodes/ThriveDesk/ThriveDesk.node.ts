import { NodeConnectionTypes } from 'n8n-workflow';
import type { INodeType, INodeTypeDescription } from 'n8n-workflow';

import { apiUrl } from '../../environment';
import { loadOptions, listSearch } from './methods';
import {
	conversationFields,
	conversationOperations,
} from './descriptions/ConversationDescription';
import { contactFields, contactOperations } from './descriptions/ContactDescription';

export class ThriveDesk implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ThriveDesk',
		name: 'thriveDesk',
		// single asset on purpose: the mark is a solid brand tile that reads on both
		// themes. `icon-prefer-themed-variants` warns here; a themed pair would need a
		// genuinely different dark file (`icon-validation` rejects duplicates).
		icon: 'file:thrivedesk.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Work with ThriveDesk conversations and contacts',
		defaults: { name: 'ThriveDesk' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'thriveDeskOAuth2Api', required: true }],
		requestDefaults: {
			baseURL: `={{$credentials.baseUrl || "${apiUrl}"}}`,
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'conversation',
				options: [
					{ name: 'Contact', value: 'contact' },
					{ name: 'Conversation', value: 'conversation' },
				],
			},
			...conversationOperations,
			...conversationFields,
			...contactOperations,
			...contactFields,
		],
	};

	methods = {
		loadOptions,
		listSearch,
	};
}
