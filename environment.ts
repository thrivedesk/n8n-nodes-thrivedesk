// Central endpoint config. Single source of truth for every ThriveDesk host so it
// can be repointed (staging, self-hosted) in one place instead of hunting
// hard-coded literals across credentials, nodes and the trigger.
//
// Compile-time constants only — no process.env / filesystem reads (verification rule).

export const appUrl = 'https://app.thrivedesk.com';
export const oauthUrl = 'https://api.thrivedesk.com';
export const apiUrl = 'https://api.thrivedesk.com/v1';
export const webhookApiVersion = '2026-05-20';
