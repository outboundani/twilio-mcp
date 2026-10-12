// twilio-mcp - an MCP server (streamable HTTP, stateless) for Twilio Studio
// and TaskRouter, running on Cloudflare Workers with zero dependencies.

import { TwilioError, TwilioClient } from './twilio.js';
import { toolDefs, callTool } from './tools.js';
import { handleOAuth, checkAuth, unauthorized, ctEqual } from './oauth.js';
import { INSTRUCTIONS } from './about.js';
import { landingPage, setupPage } from './ui.js';
import { loadConfig, saveConfig, randomToken } from './config.js';
import { isSid, redactText } from './rules.js';

export const SERVER_INFO = { name: 'twilio-mcp', version: '0.1.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Request limits. A JSON-RPC call to this server is a few KB; 256 KB is
// generous (a full Studio definition fits many times over).
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_BATCH = 10;

const CORS_BASE = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

const isMcpPath = (path) => path === '/' || path === '/mcp';

export default {
  async fetch(request, env) {
    let res;
    try {
      res = await route(request, env);
    } catch (e) {
      // Never echo exception text (it can carry request or config details).
      console.error('unhandled error', e?.name || 'Error');
      res = json({ error: 'Internal error' }, 500);
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = request.headers.get('Origin');
    for (const [k, v] of Object.entries(CORS_BASE)) res.headers.set(k, v);
    if (isMcpPath(path) && origin) {
      // The MCP endpoint answers browsers only for origins it accepts.
      if (originAllowed(request, url, env)) res.headers.set('Access-Control-Allow-Origin', origin);
      res.headers.append('Vary', 'Origin');
    } else {
      res.headers.set('Access-Control-Allow-Origin', '*');
    }
    res.headers.set('X-Content-Type-Options', 'nosniff');
    return res;
  },
};

// Browsers always send Origin on cross-origin requests; MCP clients that run
// server-side (Claude and ChatGPT connectors, SDKs, curl) send none. So: no
// Origin is fine, and a browser Origin must be this server itself, a known
// MCP client web app, a local development page, or listed in the
// MCP_ALLOWED_ORIGINS variable (comma separated; "*" turns the check off).
const DEFAULT_ALLOWED_ORIGINS = ['https://claude.ai', 'https://www.claude.ai', 'https://claude.com', 'https://www.claude.com', 'https://chatgpt.com', 'https://chat.openai.com'];
export function originAllowed(request, url, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  if (origin === url.origin) return true;
  const extra = String(env?.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.includes('*')) return true;
  if (DEFAULT_ALLOWED_ORIGINS.includes(origin) || extra.includes(origin)) return true;
  try {
    const o = new URL(origin);
    return o.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(o.hostname);
  } catch { return false; }
}

// Reads a request body without ever holding more than `max` bytes. Returns
// null when it is too large (checked up front via Content-Length, and again
// while streaming, because Content-Length can be absent or wrong).
async function readCapped(request, max) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  // Cap every POST body (MCP, setup, and OAuth endpoints) before parsing.
  if (request.method === 'POST') {
    const text = await readCapped(request, MAX_BODY_BYTES);
    if (text === null) return json({ error: `Request body too large (limit ${MAX_BODY_BYTES / 1024} KB).` }, 413);
    const headers = new Headers(request.headers);
    headers.delete('Content-Length');
    request = new Request(request.url, { method: 'POST', headers, body: text });
  }

  const cfg = await loadConfig(env);

  const extraRedirectSchemes = String(env.OAUTH_EXTRA_REDIRECT_SCHEMES ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const oauthRes = await handleOAuth(request, cfg.authToken, url, { extraRedirectSchemes });
  if (oauthRes) return oauthRes;

  if (request.method === 'GET' && path === '/') return html(landingPage(toolDefs(), cfg));
  if (request.method === 'GET' && path === '/setup') return html(setupPage(cfg));
  if (request.method === 'POST' && path === '/setup') return handleSetup(request, env, cfg);
  if (request.method === 'GET' && path === '/health') return json({ ok: true, server: SERVER_INFO, configured: cfg.configured });

  if (isMcpPath(path)) {
    if (request.method !== 'POST') {
      return json({ error: 'MCP requests must be POSTed to /mcp' }, 405);
    }
    if (!originAllowed(request, url, env)) {
      return json({ error: 'Origin not allowed. If a browser-based MCP client needs access, add its origin to the MCP_ALLOWED_ORIGINS variable.' }, 403);
    }
    // Fail closed: a server that can reach Twilio must have an access key.
    if (cfg.configured && !cfg.authToken) {
      return json({ error: 'This server has Twilio credentials but no access key. Set the MCP_AUTH_TOKEN secret (or re-run /setup) before connecting clients.' }, 503);
    }
    if (!(await checkAuth(request, cfg.authToken))) return unauthorized(url.origin);
    let body;
    try { body = await request.json(); } catch {
      return json(rpcError(null, -32700, 'Parse error: body must be JSON'), 400);
    }
    if (Array.isArray(body)) {
      if (!body.length || body.length > MAX_BATCH) return json(rpcError(null, -32600, `Invalid batch: send between 1 and ${MAX_BATCH} messages`), 400);
      const results = (await Promise.all(body.map((m) => handleMessage(m, cfg)))).filter(Boolean);
      return results.length ? json(results) : new Response(null, { status: 202 });
    }
    const result = await handleMessage(body, cfg);
    return result ? json(result) : new Response(null, { status: 202 });
  }

  return json({ error: 'Not found' }, 404);
}

// In-browser setup wizard. First run (nothing configured) is open; once
// configured, changes require the current access key. Env-managed servers
// (Wrangler secrets) can't be edited here - secrets win over KV.
async function handleSetup(request, env, cfg) {
  if (cfg.source === 'env') {
    return json({ error: 'This server is configured with Wrangler secrets, which override the setup wizard. Update it with `npx wrangler secret put`.' }, 409);
  }
  if (!cfg.hasKv) {
    return json({ error: 'No CONFIG KV namespace is bound to this Worker - add the [[kv_namespaces]] block from wrangler.toml and redeploy.' }, 500);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Body must be JSON.' }, 400); }

  if (cfg.configured) {
    const auth = request.headers.get('Authorization') || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (body.current_key || '');
    if (!cfg.authToken || !(await ctEqual(presented, cfg.authToken))) {
      return json({ error: 'This server is already configured - enter its current access key to make changes.' }, 401);
    }
  }

  const accountSid = String(body.account_sid || '').trim();
  const apiKeySid = String(body.api_key_sid || '').trim();
  const apiKeySecret = String(body.api_key_secret || '').trim();
  if (!isSid(accountSid, 'AC')) return json({ error: 'Account SID must look like AC followed by 32 hex characters.' }, 400);
  if (!isSid(apiKeySid, 'SK')) return json({ error: 'API Key SID must look like SK followed by 32 hex characters (create one under Account > API keys & tokens; never use the auth token).' }, 400);
  if (!apiKeySecret) return json({ error: 'API Key Secret is required.' }, 400);

  // Validate the credentials against Twilio before saving anything.
  let account;
  try {
    const probe = new TwilioClient({ accountSid, apiKeySid, apiKeySecret });
    account = await probe.get('api', probe.acct('.json'));
  } catch (e) {
    return json({ error: `Twilio rejected these credentials: ${e.message}` }, 400);
  }

  const isFirstRun = !cfg.configured;
  const authToken = cfg.authToken || randomToken();
  await saveConfig(env, { accountSid, apiKeySid, apiKeySecret, authToken });
  return json({
    ok: true,
    account: account.friendly_name,
    type: account.type,
    // The key is shown once, on first configuration only.
    accessKey: isFirstRun ? authToken : undefined,
    note: isFirstRun
      ? `Connected to "${account.friendly_name}" (${account.type || 'account'}). Save this access key somewhere safe - it is shown only once. Use it to connect Claude, ChatGPT, or any MCP client.`
      : `Credentials updated ("${account.friendly_name}"). Your existing access key is unchanged.`,
  });
}

export async function handleMessage(msg, cfg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return rpcError(msg?.id ?? null, -32600, 'Invalid JSON-RPC 2.0 request');
  }
  const { id, method, params } = msg;

  // Notifications (no id) get no response body.
  if (id === undefined || id === null) return null;

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: toolDefs() });
      case 'tools/call': {
        const name = params?.name;
        try {
          const result = await callTool(cfg, name, params?.arguments);
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
        } catch (e) {
          if (e instanceof TwilioError || e.message?.startsWith('Unknown tool')) {
            const known = [cfg?.apiKeySecret, cfg?.authToken].filter(Boolean);
            return rpcResult(id, { content: [{ type: 'text', text: `Error: ${redactText(e.message, known)}` }], isError: true });
          }
          throw e;
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    // Unexpected failure: generic text only. The exception message can hold
    // internals or secrets, so it is not returned (and not logged).
    console.error('internal error in', method, e?.name || 'Error');
    return rpcError(id, -32603, 'Internal error');
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Pages are never framed (clickjacking on the setup wizard) and never cached.
function html(markup) {
  return new Response(markup, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  });
}
