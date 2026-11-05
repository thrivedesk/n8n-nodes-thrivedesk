# n8n-nodes-thrivedesk

This is an [n8n](https://n8n.io) community node. It lets you use [ThriveDesk](https://thrivedesk.com) — a customer support help desk — in your n8n workflows.

ThriveDesk is a help desk platform for managing customer conversations across shared inboxes, with contacts, tags, and saved replies.

[Installation](#installation) · [Authentication](#authentication) · [Operations](#operations) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n docs.

- **n8n Cloud / self-hosted (verified):** once this node is verified, search for `n8n-nodes-thrivedesk` in **Settings → Community Nodes**.
- **Manual (self-hosted):** `npm install n8n-nodes-thrivedesk` in your n8n custom nodes directory.

## Authentication

This node authenticates with **OAuth2** (authorization code) against the ThriveDesk partner API.

1. In n8n, create a new **ThriveDesk OAuth2 API** credential.
2. Copy the **OAuth Redirect URL** shown in the credential UI.
3. Register that exact redirect URL on your ThriveDesk partner OAuth client.
4. Paste the **Client ID** and **Client Secret** from the partner client into n8n.
5. Click **Connect** and authorize the requested scopes.

### OAuth Redirect URL

n8n fixes the redirect (callback) URL — it's always `<your-n8n-host>/rest/oauth2-credential/callback`. This is the value ThriveDesk uses as the OAuth redirect; register it on the partner client exactly as shown in the n8n credential UI.

| Environment | Redirect URL |
| --- | --- |
| Local (default) | `http://localhost:5678/rest/oauth2-credential/callback` |
| Production | `https://<your-n8n-domain>/rest/oauth2-credential/callback` |

> The host/port must match your actual n8n instance. If you set `N8N_HOST`, `N8N_PORT`, `N8N_PROTOCOL`, or `WEBHOOK_URL`, the callback URL changes accordingly — always copy the exact value from the credential UI.

On connect, n8n calls `POST /v1/apps/n8n/install` to confirm the connection. That single call both
verifies the freshly issued token and auto-installs the ThriveDesk app for your organization — the
webhook routes the trigger needs only exist once the app is installed. The trigger repeats the install
call when it subscribes, because n8n does not reliably re-fire the credential test after OAuth.

Scopes requested: `profile:read`, `conversations:read`, `conversations:write`,
`contacts:read`, `contacts:write`, `inboxes:read`, `tags:read`, `tags:write`,
`users:read`, `apps:read`, `apps:write`.

## Operations

### ThriveDesk node

- **Conversation** — Create, Reply, Add Note, Update, Add Tag, Remove Tag, Get, Get Many
- **Contact** — Create, Create or Update (upsert), Update, Get, Get Many

Notes on a few operations:

- **Conversation → Get Many** lists through `POST /search`, so it accepts the same filters as the
  ThriveDesk UI search (keyword, contact email, status, priority, inbox, assignee, tags). Search is a
  paid ThriveDesk add-on.
- **Contact → Create** takes only an email — the API persists nothing else on create. Use
  **Create or Update** to set name, company, phone and the rest; it looks the contact up by email and
  patches it, creating it first if it does not exist.

### ThriveDesk Trigger node

Fires when a subscribed ThriveDesk webhook event arrives:

`conversation.created`, `conversation.assigned`, `conversation.status_updated`,
`conversation.tags_updated`, `conversation.contact_replied`, `conversation.agent_replied`,
`conversation.note_added`, `conversation.rated`.

Each trigger is bound to one event **and** one inbox — there is no all-inboxes wildcard. Optional
filters narrow it further, and are applied by the backend per event type: **assignee** on Created and
Assigned, **status** on Created and Status Updated, **tags** on Created and Tags Updated.

## Compatibility

Requires n8n with `n8nNodesApiVersion` 1. Node.js >= 20.15.

## Development

```bash
npm install
npm run dev          # watch + run in a local n8n
npm run dev:managed  # same, with a managed OAuth client from .credentials-overwrite.local.json
npm run lint         # n8n pre-publish lint ruleset
npm run build        # compile to dist/
npm run test         # jest unit tests
```

This package follows the [verified community node](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/) rules: zero runtime dependencies, MIT licensed, English only, built with `@n8n/node-cli`.

## Resources

- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [ThriveDesk](https://thrivedesk.com)

## License

[MIT](LICENSE)
