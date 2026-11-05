import type {
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

import { apiUrl, appUrl, oauthUrl } from '../environment';

// OAuth endpoints derived from the configured hosts. Authorize is browser-facing
// (appUrl); token exchange hits the API host (oauthUrl).
const authorizeUrl = `${appUrl}/oauth/authorize`;
const tokenUrl = `${oauthUrl}/oauth/token`;

// Final scope set (PLAN §0). apps:read / apps:write gate the backend auto-install
// and the webhook subscribe routes used by the trigger node.
const scopes = [
	'profile:read',
	'conversations:read',
	'conversations:write',
	'contacts:read',
	'contacts:write',
	'inboxes:read',
	'tags:read',
	'tags:write',
	'users:read',
	'apps:read',
	'apps:write',
];

export class ThriveDeskOAuth2Api implements ICredentialType {
	name = 'thriveDeskOAuth2Api';

	displayName = 'ThriveDesk OAuth2 API';

	icon: Icon = 'file:thrivedesk.svg';

	extends = ['oAuth2Api'];

	documentationUrl = 'https://github.com/thrivedesk/td-n8n-app#authentication';

	properties: INodeProperties[] = [
		// Authorization-code flow, all protocol values pinned and hidden so the user
		// only taps "Connect to ThriveDesk" — no manual field entry.
		//
		// Client ID / Client Secret are intentionally NOT defined here. They come
		// from the oAuth2Api base and are supplied at runtime via n8n credential
		// overwrites (CREDENTIALS_OVERWRITE_DATA), keyed by this credential's
		// `name` ('thriveDeskOAuth2Api'). n8n then hides both fields and renders the
		// inline "Connect" button — same model HelpScout uses on n8n Cloud. The
		// secret lives only on the n8n host, never in this package. See docs/MANAGED_OAUTH.md.
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'authorizationCode',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: authorizeUrl,
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: tokenUrl,
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			// ThriveDesk partner API uses space-separated scopes.
			default: scopes.join(' '),
		},
		{
			// Forces ThriveDesk to return a refresh token. Missing refresh token is
			// the #1 OAuth2 node failure mode.
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: 'access_type=offline&prompt=consent',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
		},
		{
			// Hidden so the credential modal shows nothing but the Connect button.
			// Still consumed by the node requestDefaults and the credential test below.
			// For staging, point at a staging host via a credential overwrite.
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'hidden',
			default: apiUrl,
		},
		{
			// n8n auto-injects an "Allowed HTTP Request Domains" control into any
			// oAuth2Api-based credential. Left at the UI default it can land on
			// "None", which makes n8n reject every request from this node with
			// "This credential is configured to prevent use within an HTTP Request
			// node" (see n8n-workflow credential-domain-restrictions). This is a
			// predefined node bound to the ThriveDesk API, so pin the control to
			// "all" and hide it — defining the property here suppresses n8n's
			// injected field, so the user can never accidentally lock the node out.
			displayName: 'Allowed HTTP Request Domains',
			name: 'allowedHttpRequestDomains',
			type: 'hidden',
			default: 'all',
		},
	];

	// Runs automatically the moment OAuth completes (n8n fires the credential test
	// right after the token exchange). We use it to POST the backend install — the
	// same step Make does in its `info` block and Zapier on connect: it registers
	// the n8n app for the org, returns oauth_client_id + org info, and confirms the
	// token works. Backend route: POST {apiUrl}/apps/n8n/install (scope apps:write).
	test: ICredentialTestRequest = {
		request: {
			baseURL: `={{$credentials.baseUrl || "${apiUrl}"}}`,
			url: '/apps/n8n/install',
			method: 'POST',
			body: {
				source: 'n8n',
			},
		},
	};
}
