// Minimal OAuth 2.1 authorization server so MCP clients (claude.ai custom
// connectors, Claude Desktop, etc.) can connect with their standard OAuth flow
// instead of a hand-configured header.
//
// Single-operator model: the "login" on the consent screen is the server's
// access key (MCP_AUTH_TOKEN). Everything is stateless - client ids, auth
// codes, and tokens are HMAC-signed blobs, so no storage is needed.
//
// (Note: this is the MCP-client-facing auth. It is unrelated to the Twilio
// API key the Worker uses to reach Twilio's REST APIs.)
//
// Hardening in this file (see test/oauth.test.js):
//   - tokens are signed with an HKDF-derived subkey, never the raw access key
//   - every secret, signature, PKCE and binding comparison is constant time
//   - tokens are audience-bound (`aud` = this server's /mcp URL) and
//     client-bound (`ci` = SHA-256 of the client id)
//   - access tokens last 1 hour; refresh tokens 30 days (sliding, 90 day cap)
//   - auth codes last 5 minutes and are bound to client_id, redirect_uri, PKCE
//   - registered redirect URIs must be https or loopback http
//   - the consent page names the client and where it will send you back
//
// STATELESS LIMITS (documented, not hidden):
//   - Auth codes are NOT single-use. Replay is limited by the 5 minute expiry,
//     PKCE (an attacker needs the verifier too), and the client/redirect
//     binding. TODO: single use needs a store (KV with a short TTL on the code
//     id `jti`, or a Durable Object); it is not added here because the Worker
//     has no mandatory storage.
//   - Refresh tokens are ROTATED (every refresh returns a new one) but the old
//     one cannot be revoked statelessly: it stays valid until its own expiry.
//     Rotation therefore gives a sliding window, capped at MAX_SESSION from the
//     original consent, rather than reuse detection.
//   - Revoking everything: rotate MCP_AUTH_TOKEN. All tokens derive from it, so
//     every outstanding token, code and client id stops verifying at once.

const enc = new TextEncoder();

// ---------- encoding ----------

function bytesToB64url(bytes) {
  const arr = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToString(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}

// ---------- constant-time comparison ----------

// Compares two strings without leaking where they differ (or their lengths):
// both are hashed to fixed-size SHA-256 digests, then the digests are
// compared with a branch-free XOR accumulator. (crypto.subtle.timingSafeEqual
// exists on Workers but not in every runtime this is tested on.)
export async function ctEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false; // missing never equals anything, not even ''
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- signing ----------

// The access key is the operator's bearer secret. Tokens are NOT signed with
// it directly: an HKDF subkey (domain-separated by salt and info) signs them,
// so a token or signature can never be confused with, or help recover, the
// bearer key itself.
async function signingKey(accessKey) {
  const ikm = await crypto.subtle.importKey('raw', enc.encode(accessKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('twilio-mcp/oauth/v2'), info: enc.encode('token-hmac-sha256') },
    ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'],
  );
}

async function hmac(key, data) {
  return bytesToB64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

// Pre-hardening deployments signed with the raw access key. Only CLIENT IDs
// (which are public identifiers) are still accepted in that form, so an
// already-registered connector can re-run consent without being re-added.
// Legacy tokens and codes are not accepted.
async function legacyHmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hmac(key, data);
}

export async function mintToken(accessKey, payload) {
  const data = bytesToB64url(enc.encode(JSON.stringify(payload)));
  return `${data}.${await hmac(await signingKey(accessKey), data)}`;
}

async function readToken(accessKey, token, { legacy = false } = {}) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [data, sig] = parts;
  const ok = await ctEqual(await hmac(await signingKey(accessKey), data), sig);
  const legacyOk = !ok && legacy && await ctEqual(await legacyHmac(accessKey, data), sig);
  if (!ok && !legacyOk) return null;
  try {
    const payload = JSON.parse(b64urlToString(data));
    if (!payload || typeof payload !== 'object') return null;
    return legacyOk ? { ...payload, legacy: true } : payload;
  } catch { return null; }
}

const sha256b64url = async (s) => bytesToB64url(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const now = () => Math.floor(Date.now() / 1000);

export const ACCESS_TTL = 3600;                // 1 hour
export const REFRESH_TTL = 30 * 24 * 3600;     // 30 days, sliding
export const MAX_SESSION = 90 * 24 * 3600;     // absolute cap from the original consent
export const CODE_TTL = 300;                   // 5 minutes

const live = (p) => typeof p?.exp === 'number' && p.exp > now();
const resourceFor = (origin) => `${origin}/mcp`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' },
  });
}
const oauthError = (error, description, status = 400) => json(description ? { error, error_description: description } : { error }, status);

// ---------- redirect URI and input validation ----------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const NEVER_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'blob', 'about', 'ftp', 'ws', 'wss', 'http', 'https']);

// Returns true when `uri` may be registered and redirected to: https, or
// http on a loopback host (native and local apps), or an explicitly enabled
// custom scheme (OAUTH_EXTRA_REDIRECT_SCHEMES, e.g. "cursor,vscode"). No
// fragments, no embedded credentials, and javascript:/data:/etc. never.
export function validRedirectUri(uri, extraSchemes = []) {
  if (typeof uri !== 'string' || !uri || uri.length > 2048 || /[\s\u0000-\u001f]/.test(uri)) return false;
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || uri.includes('#') || u.username || u.password) return false;
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === 'https') return Boolean(u.hostname);
  if (scheme === 'http') return LOOPBACK.has(u.hostname);
  if (NEVER_SCHEMES.has(scheme)) return false;
  return extraSchemes.map((s) => s.toLowerCase()).includes(scheme);
}

const cleanName = (n) => (typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 80) : '') || 'Unnamed MCP client';
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const MAX_STATE = 512;

async function readClient(accessKey, clientId) {
  const c = await readToken(accessKey || '', clientId, { legacy: true });
  if (c?.t !== 'client' || !Array.isArray(c.r) || !c.r.length) return null;
  return c;
}

// ---------- auth for the MCP endpoint ----------

// True if the request may use the MCP endpoint. `accessKey` is the server's
// configured access key (from env or KV - see config.js). Accepts either the
// access key itself as a bearer token (static-header clients) or an OAuth
// access token minted by this server for THIS server's /mcp URL.
export async function checkAuth(request, accessKey) {
  if (!accessKey) return true; // auth not configured - index.js fails closed when Twilio is configured
  const header = request.headers.get('Authorization') || '';
  if (!/^Bearer /i.test(header)) return false;
  const presented = header.slice(7).trim();
  if (!presented) return false;
  if (await ctEqual(presented, accessKey)) return true; // raw access key still works
  const payload = await readToken(accessKey, presented);
  if (payload?.t !== 'a' || !live(payload)) return false;
  return typeof payload.aud === 'string' && await ctEqual(payload.aud, resourceFor(new URL(request.url).origin));
}

export function unauthorized(origin) {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  });
}

// ---------- the OAuth endpoints ----------

// Routes any OAuth-related path; returns null if the path isn't ours.
// opts.extraRedirectSchemes: custom URI schemes to accept for redirect URIs
// (off by default; https and loopback http are always accepted).
export async function handleOAuth(request, accessKey, url, opts = {}) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const origin = url.origin;
  const extraSchemes = opts.extraRedirectSchemes || [];

  if (path.startsWith('/.well-known/oauth-authorization-server')) {
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ['twilio'],
    });
  }

  if (path.startsWith('/.well-known/oauth-protected-resource')) {
    return json({
      resource: resourceFor(origin),
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: ['twilio'],
    });
  }

  if (path === '/register' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return oauthError('invalid_client_metadata'); }
    if (!body || typeof body !== 'object') return oauthError('invalid_client_metadata');
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!redirectUris.length || redirectUris.length > 5) return oauthError('invalid_redirect_uri', 'Provide between 1 and 5 redirect_uris.');
    const bad = redirectUris.filter((u) => !validRedirectUri(u, extraSchemes));
    if (bad.length) return oauthError('invalid_redirect_uri', 'redirect_uris must be https URLs or http://localhost, 127.0.0.1, or [::1] (no fragments, no credentials, no javascript: or data:).');
    if (!accessKey) return json({ error: 'server_not_configured', error_description: 'MCP_AUTH_TOKEN is not set on this Worker.' }, 500);
    const name = cleanName(body.client_name);
    const clientId = await mintToken(accessKey, { t: 'client', r: redirectUris, n: name, iat: now() });
    return json({
      client_id: clientId,
      redirect_uris: redirectUris,
      client_name: name,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }, 201);
  }

  if (path === '/authorize' && request.method === 'GET') {
    const q = url.searchParams;
    if (!accessKey) return authPage({ error: 'This server has no MCP_AUTH_TOKEN configured - the operator must set one before OAuth can be used.' });
    const clientId = q.get('client_id') || '';
    const redirectUri = q.get('redirect_uri') || '';
    const client = await readClient(accessKey, clientId);
    if (!client || !client.r.includes(redirectUri) || !validRedirectUri(redirectUri, extraSchemes)) {
      return authPage({ error: 'Unknown client or redirect URI. Re-add the connector so it re-registers.' });
    }
    const problem = requestProblem({ responseType: q.get('response_type'), codeChallenge: q.get('code_challenge'), method: q.get('code_challenge_method'), state: q.get('state') || '', resource: q.get('resource'), origin });
    if (problem) return authPage({ error: problem });
    return authPage({
      clientId, clientName: client.n, redirectUri,
      state: q.get('state') || '',
      codeChallenge: q.get('code_challenge'),
    });
  }

  if (path === '/authorize' && request.method === 'POST') {
    if (!accessKey) return authPage({ error: 'This server has no MCP_AUTH_TOKEN configured.' });
    const form = await request.formData();
    const key = String(form.get('access_key') || '');
    const clientId = String(form.get('client_id') || '');
    const redirectUri = String(form.get('redirect_uri') || '');
    const state = String(form.get('state') || '');
    const codeChallenge = String(form.get('code_challenge') || '');
    const client = await readClient(accessKey, clientId);
    if (!client || !client.r.includes(redirectUri) || !validRedirectUri(redirectUri, extraSchemes)) {
      return authPage({ error: 'Invalid authorization request. Re-add the connector and try again.' });
    }
    const problem = requestProblem({ responseType: 'code', codeChallenge, method: 'S256', state, origin });
    if (problem) return authPage({ error: problem });
    if (!(await ctEqual(key, accessKey))) {
      return authPage({ clientId, clientName: client.n, redirectUri, state, codeChallenge, error: 'Wrong access key - check with the operator of this server.' });
    }
    const code = await mintToken(accessKey, {
      t: 'code', ci: await sha256b64url(clientId), ru: redirectUri, cc: codeChallenge,
      aud: resourceFor(origin), iat: now(), exp: now() + CODE_TTL,
      jti: randomId(), // reserved for single-use enforcement (see header TODO)
    });
    const dest = new URL(redirectUri);
    dest.searchParams.set('code', code);
    if (state) dest.searchParams.set('state', state);
    dest.searchParams.set('iss', origin);
    return new Response(null, { status: 302, headers: { Location: dest.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }

  if (path === '/token' && request.method === 'POST') {
    if (!accessKey) return json({ error: 'server_error' }, 500);
    const form = await request.formData();
    const grantType = form.get('grant_type');
    const clientId = String(form.get('client_id') || '');
    if (!clientId) return oauthError('invalid_request', 'client_id is required.');
    const clientHash = await sha256b64url(clientId);
    const aud = resourceFor(origin);

    if (grantType === 'authorization_code') {
      const code = await readToken(accessKey, form.get('code'));
      if (code?.t !== 'code' || !live(code)) return oauthError('invalid_grant');
      if (!(await ctEqual(code.aud, aud)) || !(await ctEqual(code.ci, clientHash))) return oauthError('invalid_grant');
      const redirectUri = form.get('redirect_uri');
      if (!redirectUri) return oauthError('invalid_request', 'redirect_uri is required and must match the authorization request.');
      if (!(await ctEqual(redirectUri, code.ru))) return oauthError('invalid_grant');
      const verifier = String(form.get('code_verifier') || '');
      if (!PKCE_VERIFIER.test(verifier)) return oauthError('invalid_grant', 'PKCE verification failed');
      if (!(await ctEqual(await sha256b64url(verifier), code.cc))) return oauthError('invalid_grant', 'PKCE verification failed');
      return json(await issueTokens(accessKey, { aud, ci: clientHash, oi: now() }));
    }

    if (grantType === 'refresh_token') {
      const refresh = await readToken(accessKey, form.get('refresh_token'));
      if (refresh?.t !== 'r' || !live(refresh)) return oauthError('invalid_grant');
      if (!(await ctEqual(refresh.aud, aud)) || !(await ctEqual(refresh.ci, clientHash))) return oauthError('invalid_grant');
      if (typeof refresh.oi !== 'number' || now() > refresh.oi + MAX_SESSION) return oauthError('invalid_grant', 'Session expired - authorize again.');
      return json(await issueTokens(accessKey, { aud, ci: clientHash, oi: refresh.oi }));
    }

    return oauthError('unsupported_grant_type');
  }

  return null;
}

// Returns an error string for a bad authorization request, or null.
function requestProblem({ responseType, codeChallenge, method, state, resource, origin }) {
  if (responseType !== 'code' || method !== 'S256' || !PKCE_CHALLENGE.test(codeChallenge || '')) {
    return 'This server requires response_type=code with an S256 PKCE challenge.';
  }
  if (state.length > MAX_STATE) return 'The state parameter is too long.';
  if (resource) {
    let r;
    try { r = new URL(resource); } catch { return 'The resource parameter is not a valid URL.'; }
    if (r.origin !== origin) return 'The requested resource is not this server.';
  }
  return null;
}

const randomId = () => bytesToB64url(crypto.getRandomValues(new Uint8Array(12)));

async function issueTokens(accessKey, { aud, ci, oi }) {
  const iat = now();
  // Every token carries a random jti, so each refresh really returns a
  // different token (and a future revocation list has an id to key on).
  return {
    access_token: await mintToken(accessKey, { t: 'a', aud, ci, iat, exp: iat + ACCESS_TTL, jti: randomId() }),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: await mintToken(accessKey, { t: 'r', aud, ci, oi, iat, exp: Math.min(iat + REFRESH_TTL, oi + MAX_SESSION), jti: randomId() }),
    scope: 'twilio',
  };
}

// ---------- consent page ----------

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hostOf(uri) {
  try { const u = new URL(uri); return u.host || u.protocol; } catch { return '(unknown)'; }
}

function authPage({ clientId, clientName, redirectUri, state, codeChallenge, error }) {
  const form = clientId ? `
  <div class="who">
    <p><strong>${esc(clientName || 'Unnamed MCP client')}</strong> is asking to connect to this server.</p>
    <p>After you approve, your browser is sent back to <code>${esc(hostOf(redirectUri))}</code>:<br><small>${esc(redirectUri)}</small></p>
  </div>
  <div class="warn"><strong>Check before you continue.</strong> The app's name is chosen by the app itself and is not verified. Approve only if you just started this connection and the address above is the one you expect. An approved app can use every tool on this server, including creating Twilio task queues, workflows, and Studio flows.</div>
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${esc(clientId)}">
    <input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
    <input type="hidden" name="state" value="${esc(state)}">
    <input type="hidden" name="code_challenge" value="${esc(codeChallenge)}">
    <label for="access_key">Access key</label>
    <input type="password" id="access_key" name="access_key" autofocus autocomplete="current-password" placeholder="Paste the server access key">
    <button type="submit">Authorize</button>
  </form>` : '';
  return new Response(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize · twilio-mcp</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:460px;margin:10vh auto;padding:0 1.25rem;line-height:1.55;color:#1a2332}
  h1{font-size:1.35rem;letter-spacing:-.02em}
  .err{background:#fde8e8;color:#9b1c1c;border-radius:8px;padding:.6rem .8rem;margin:1rem 0;font-size:.92rem}
  .warn{background:#fff7e0;color:#6b4e00;border-radius:8px;padding:.6rem .8rem;margin:1rem 0;font-size:.88rem}
  .who p{margin:.3rem 0}
  code,small{word-break:break-all}
  label{display:block;font-size:.85rem;font-weight:600;margin:1.2rem 0 .3rem}
  input[type=password]{width:100%;box-sizing:border-box;padding:.6rem .7rem;border:1px solid #cbd5e1;border-radius:8px;font-size:1rem}
  button{margin-top:1rem;width:100%;padding:.65rem;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#1d4ed8}
  p{color:#5b6779;font-size:.92rem}
  @media (prefers-color-scheme:dark){body{background:#0f141b;color:#dbe2ea}input[type=password]{background:#1e2733;border-color:#334155;color:#dbe2ea}p{color:#93a1b3}.err{background:#3b1219;color:#f6b1b1}.warn{background:#3a2e0b;color:#f3d98a}}
</style></head><body>
<h1>🔐 twilio-mcp</h1>
${clientId ? '' : '<p>An AI client is asking for access to this Twilio MCP server.</p>'}
${error ? `<div class="err">${esc(error)}</div>` : ''}
${form}
</body></html>`, {
    status: error && !clientId ? 400 : 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
