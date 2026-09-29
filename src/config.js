// Configuration resolution. Two sources, env wins:
//   1. Wrangler secrets / vars (TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID,
//      TWILIO_API_KEY_SECRET, MCP_AUTH_TOKEN)
//   2. The KV-stored config written by the in-browser setup wizard (/setup)
//
// Auth to Twilio is an API Key (SK...) and its secret over HTTP Basic, plus
// the Account SID (AC...) the key belongs to. Never the account auth token.

const KV_KEY = 'twilio-config';

export async function loadConfig(env) {
  let stored = null;
  if (env.CONFIG) {
    try { stored = await env.CONFIG.get(KV_KEY, 'json'); } catch { /* KV unavailable */ }
  }
  const envManaged = Boolean(env.TWILIO_ACCOUNT_SID || env.TWILIO_API_KEY_SID || env.TWILIO_API_KEY_SECRET);
  const cfg = {
    accountSid: (envManaged ? env.TWILIO_ACCOUNT_SID : stored?.accountSid) || '',
    apiKeySid: (envManaged ? env.TWILIO_API_KEY_SID : stored?.apiKeySid) || '',
    apiKeySecret: (envManaged ? env.TWILIO_API_KEY_SECRET : stored?.apiKeySecret) || '',
    authToken: env.MCP_AUTH_TOKEN || stored?.authToken || '',
    source: envManaged ? 'env' : (stored ? 'kv' : 'none'),
    hasKv: Boolean(env.CONFIG),
  };
  cfg.configured = Boolean(cfg.accountSid && cfg.apiKeySid && cfg.apiKeySecret);
  return cfg;
}

export async function saveConfig(env, { accountSid, apiKeySid, apiKeySecret, authToken }) {
  await env.CONFIG.put(KV_KEY, JSON.stringify({ accountSid, apiKeySid, apiKeySecret, authToken }));
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
