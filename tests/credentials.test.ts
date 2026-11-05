import { ThriveDeskOAuth2Api } from '../credentials/ThriveDeskOAuth2Api.credentials';
import { appUrl, oauthUrl } from '../environment';

describe('ThriveDeskOAuth2Api credential', () => {
	const cred = new ThriveDeskOAuth2Api();

	it('has the expected identity and extends oAuth2Api', () => {
		expect(cred.name).toBe('thriveDeskOAuth2Api');
		expect(cred.extends).toEqual(['oAuth2Api']);
	});

	it('pins authorization-code flow with hidden auth/token URLs', () => {
		const byName = Object.fromEntries(cred.properties.map((p) => [p.name, p]));
		expect(byName.grantType.default).toBe('authorizationCode');
		expect(byName.grantType.type).toBe('hidden');
		// Derived from environment.ts so the assertion holds for dev or prod hosts.
		expect(byName.authUrl.default).toBe(`${appUrl}/oauth/authorize`);
		expect(byName.accessTokenUrl.default).toBe(`${oauthUrl}/oauth/token`);
	});

	it('requests the full §0 scope set including apps:read/apps:write', () => {
		const scope = cred.properties.find((p) => p.name === 'scope');
		const scopes = String(scope?.default).split(' ');
		expect(scopes).toContain('apps:read');
		expect(scopes).toContain('apps:write');
		expect(scopes).toContain('conversations:write');
		expect(scopes).toHaveLength(11);
	});

	it('forces a refresh token via auth query parameters', () => {
		const aqp = cred.properties.find((p) => p.name === 'authQueryParameters');
		expect(aqp?.default).toContain('access_type=offline');
		expect(aqp?.default).toContain('prompt=consent');
	});

	it('registers the app on connect via POST /apps/n8n/install', () => {
		expect(cred.test.request.url).toBe('/apps/n8n/install');
		expect(cred.test.request.method).toBe('POST');
	});
});
