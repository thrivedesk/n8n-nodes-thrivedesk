# n8n-nodes-thrivedesk

This is an [n8n](https://n8n.io) community node. It lets you use [ThriveDesk](https://thrivedesk.com) — a customer support help desk — in your n8n workflows.

ThriveDesk is a help desk platform for managing customer conversations across shared inboxes, with contacts, tags, and saved replies.

[Installation](#installation) · [Authentication](#authentication) · [Operations](#operations) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

This node is available on **n8n Cloud**. In your n8n workspace, open the nodes panel, search for
**ThriveDesk**, and add it to your workflow.

> **Self-hosted n8n is not supported.** The node connects through ThriveDesk's own OAuth app, which
> n8n Cloud manages for you. ThriveDesk does not issue OAuth client IDs or secrets to individual
> users, so a self-hosted n8n instance cannot complete the connection.

## Authentication

The node uses **OAuth2**, managed by n8n Cloud — there is no client ID, secret, or redirect URL to
configure.

1. In n8n, create a new **ThriveDesk OAuth2 API** credential.
2. Click **Connect my account**.
3. Sign in to ThriveDesk and approve the requested permissions.

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

n8n Cloud only (see [Installation](#installation)). Requires `n8nNodesApiVersion` 1.

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
