import type { IExecuteSingleFunctions, INodeExecutionData } from 'n8n-workflow';
import { simplifyResponse } from '../nodes/ThriveDesk/descriptions/shared';

function makeContext(simplify: boolean): IExecuteSingleFunctions {
	return {
		getNodeParameter: () => simplify,
	} as unknown as IExecuteSingleFunctions;
}

const items: INodeExecutionData[] = [
	{
		json: {
			id: 1,
			subject: 'Hi',
			status: 'active',
			threads: [{ a: 1 }],
			events: [{ b: 2 }],
			custom_fields: { x: 1 },
		},
	},
];

describe('simplifyResponse postReceive', () => {
	it('strips heavy nested fields when simplify is on', async () => {
		const out = await simplifyResponse.call(makeContext(true), items);
		expect(out[0].json).toEqual({ id: 1, subject: 'Hi', status: 'active' });
	});

	it('returns the raw items when simplify is off', async () => {
		const out = await simplifyResponse.call(makeContext(false), items);
		expect(out[0].json).toHaveProperty('threads');
		expect(out[0].json).toHaveProperty('events');
	});
});
