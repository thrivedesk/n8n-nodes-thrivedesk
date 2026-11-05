// n8n community-node lint config. The @n8n/node-cli package bundles the
// pre-publish ruleset (eslint-plugin-n8n-nodes-base) plus the credentials/nodes
// overrides used by verification. `npm run lint` runs `n8n-node lint`.
import { config } from '@n8n/node-cli/eslint';

export default config;
