// OAuth surface: checkAuth (bearer key and minted tokens) and the full
// register -> authorize -> token -> refresh flow, plus every rejection path.
// Pure Web Crypto and Request/Response, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAuth, handleOAuth, mintToken, ctEqual, validRedirectUri,
  ACCESS_TTL, REFRESH_TTL, MAX_SESSION, CODE_TTL,
} from '../src/oauth.js';

const KEY = 'k'.repeat(64);
const OTHER_KEY = 'z'.repeat(64);
const ORIGIN = 'https://mcp.example.test';
const MCP = `${ORIGIN}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

const pkcePair = async (verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))) => ({
  verifier,
  challenge: b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
});

const oauth = (path, { method = 'GET', body, key = KEY, origin = ORIGIN, opts } = {}) => {
  const url = new URL(`${origin}${path}`);
  const init = { method };
  if (body instanceof URLSearchParams) { init.body = body; init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; }
  else if (body) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
  return handleOAuth(new Request(url, init), key, url, opts);
};
const bearer = (token, origin = ORIGIN) => new Request(`${origin}/mcp`, { method: 'POST', headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } });
const decode = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

async function register(uris = [REDIRECT], name = 'Claude', opts) {
  const res = await oauth('/register', { method: 'POST', body: { redirect_uris: uris, client_name: name }, opts });
  return { res, body: res.status === 201 ? await res.json() : await res.json().catch(() => null) };
}

// Runs consent and returns { code, location }.
async function authorize({ clientId, redirectUri = REDIRECT, state = 'st8', challenge, key = KEY, origin = ORIGIN }) {
  const form = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, code_challenge: challenge, access_key: key });
  const res = await oauth('/authorize', { method: 'POST', body: form, origin });
  return { res, location: res.headers.get('Location'), code: res.headers.get('Location') ? new URL(res.headers.get('Location')).searchParams.get('code') : null };
}

const tokenReq = (fields, origin = ORIGIN) => oauth('/token', { method: 'POST', body: new URLSearchParams(fields), origin });

async function fullFlow() {
  const { body: client } = await register();
  const { verifier, challenge } = await pkcePair();
  const { code } = await authorize({ clientId: client.client_id, challenge });
  const res = await tokenReq({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
  return { client, verifier, challenge, code, res, tokens: res.status === 200 ? await res.json() : null };
}

// ---------- ctEqual ----------

test('ctEqual: equal, different, different length, and non-string inputs', async () => {
  assert.equal(await ctEqual('abc', 'abc'), true);
  assert.equal(await ctEqual('abc', 'abd'), false);
  assert.equal(await ctEqual('abc', 'abcd'), false);
  assert.equal(await ctEqual('', ''), true);
  assert.equal(await ctEqual(undefined, ''), false, 'a missing value never equals the empty string');
  assert.equal(await ctEqual(null, null), false);
  assert.equal(await ctEqual(new URLSearchParams().get('x'), 'x'), false);
  assert.equal(await ctEqual('a'.repeat(10000), 'a'.repeat(10000)), true);
});

// ---------- checkAuth ----------

test('checkAuth: missing key (open server), missing header, wrong key, right key', async () => {
  assert.equal(await checkAuth(bearer(undefined), ''), true, 'no access key configured = open (index.js fails closed when Twilio is configured)');
  assert.equal(await checkAuth(bearer(undefined), KEY), false, 'no Authorization header');
  assert.equal(await checkAuth(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: 'Basic abc' } }), KEY), false, 'wrong scheme');
  assert.equal(await checkAuth(bearer(''), KEY), false, 'empty bearer');
  assert.equal(await checkAuth(bearer(OTHER_KEY), KEY), false, 'wrong key');
  assert.equal(await checkAuth(bearer(KEY.slice(0, -1)), KEY), false, 'prefix of the key');
  assert.equal(await checkAuth(bearer(`${KEY}x`), KEY), false);
  assert.equal(await checkAuth(bearer(KEY), KEY), true, 'the raw access key still works as a bearer');
  assert.equal(await checkAuth(new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `bearer ${KEY}` } }), KEY), true, 'scheme is case-insensitive');
});

test('checkAuth: forged, tampered, legacy-signed, and cross-key tokens are rejected', async () => {
  const payload = { t: 'a', aud: MCP, ci: 'x', iat: now(), exp: now() + 600 };
  const good = await mintToken(KEY, payload);
  assert.equal(await checkAuth(bearer(good), KEY), true, 'sanity: a properly minted token passes');
  // Signed with another key.
  assert.equal(await checkAuth(bearer(await mintToken(OTHER_KEY, payload)), KEY), false);
  // Payload swapped under a valid signature (tamper).
  const [, sig] = good.split('.');
  const evil = Buffer.from(JSON.stringify({ ...payload, exp: now() + 99999999 })).toString('base64url');
  assert.equal(await checkAuth(bearer(`${evil}.${sig}`), KEY), false);
  // Truncated, empty parts, extra parts, garbage.
  for (const t of [good.slice(0, -2), `${good}.extra`, '.', 'a.', '.b', 'notatoken', `${good.split('.')[0]}.`]) assert.equal(await checkAuth(bearer(t), KEY), false, t);
  // The pre-hardening scheme signed with the RAW access key; such tokens are no longer honored.
  const data = Buffer.from(JSON.stringify({ t: 'a', exp: now() + 600 })).toString('base64url');
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const legacySig = b64url(await crypto.subtle.sign('HMAC', raw, new TextEncoder().encode(data)));
  assert.equal(await checkAuth(bearer(`${data}.${legacySig}`), KEY), false, 'raw-key HMAC tokens are rejected (subkey is HKDF-derived)');
});

test('checkAuth: expired, wrong audience, wrong type, and wrong server are rejected', async () => {
  const mk = (over) => mintToken(KEY, { t: 'a', aud: MCP, ci: 'x', iat: now() - 10, exp: now() + 600, ...over });
  assert.equal(await checkAuth(bearer(await mk({})), KEY), true);
  assert.equal(await checkAuth(bearer(await mk({ exp: now() - 1 })), KEY), false, 'expired');
  assert.equal(await checkAuth(bearer(await mk({ exp: undefined })), KEY), false, 'no expiry');
  assert.equal(await checkAuth(bearer(await mk({ exp: 'soon' })), KEY), false, 'non-numeric expiry');
  assert.equal(await checkAuth(bearer(await mk({ aud: undefined })), KEY), false, 'no audience');
  assert.equal(await checkAuth(bearer(await mk({ aud: 'https://other.example/mcp' })), KEY), false, 'token for a different resource');
  assert.equal(await checkAuth(bearer(await mk({ t: 'r' })), KEY), false, 'a refresh token is not an access token');
  assert.equal(await checkAuth(bearer(await mk({ t: 'code' })), KEY), false, 'an auth code is not an access token');
  assert.equal(await checkAuth(bearer(await mk({ t: 'client' })), KEY), false, 'a client id is not an access token');
  // Same token presented to a different origin (audience pinned to THIS /mcp URL).
  assert.equal(await checkAuth(bearer(await mk({}), 'https://evil.example'), KEY), false);
});

// ---------- the happy path ----------

test('flow: register -> consent -> code -> token -> use -> refresh', async () => {
  const f = await fullFlow();
  assert.equal(f.res.status, 200);
  assert.equal(f.res.headers.get('Cache-Control'), 'no-store');
  const t = f.tokens;
  assert.equal(t.token_type, 'Bearer');
  assert.equal(t.expires_in, ACCESS_TTL);
  assert.equal(ACCESS_TTL, 3600, 'access tokens last 1 hour');
  assert.equal(REFRESH_TTL, 30 * 24 * 3600, 'refresh tokens last 30 days');
  const a = decode(t.access_token);
  assert.equal(a.t, 'a');
  assert.equal(a.aud, MCP, 'audience pinned to the /mcp URL');
  assert.equal(a.exp - a.iat, 3600);
  const r = decode(t.refresh_token);
  assert.equal(r.t, 'r');
  assert.equal(r.aud, MCP);
  assert.ok(r.exp - r.iat <= REFRESH_TTL);
  assert.equal(await checkAuth(bearer(t.access_token), KEY), true);
  assert.equal(await checkAuth(bearer(t.refresh_token), KEY), false);
  // Refresh rotates: a new pair comes back and the new access token works.
  const rr = await tokenReq({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: f.client.client_id });
  assert.equal(rr.status, 200);
  const t2 = await rr.json();
  assert.notEqual(t2.refresh_token, t.refresh_token, 'refresh token is rotated');
  assert.equal(decode(t2.refresh_token).oi, r.oi, 'the original consent time is carried, so the session cap holds');
  assert.equal(await checkAuth(bearer(t2.access_token), KEY), true);
});

test('authorize redirect carries code, state, and iss; the code is short lived and bound', async () => {
  const { body: client } = await register();
  const { challenge } = await pkcePair();
  const { res, location, code } = await authorize({ clientId: client.client_id, challenge, state: 'abc 123&x' });
  assert.equal(res.status, 302);
  const u = new URL(location);
  assert.equal(`${u.origin}${u.pathname}`, REDIRECT);
  assert.equal(u.searchParams.get('state'), 'abc 123&x');
  assert.equal(u.searchParams.get('iss'), ORIGIN);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const c = decode(code);
  assert.equal(c.t, 'code');
  assert.equal(c.exp - c.iat, CODE_TTL);
  assert.equal(CODE_TTL, 300, 'auth codes last 5 minutes');
  assert.equal(c.aud, MCP);
  assert.equal(c.ru, REDIRECT);
});

// ---------- consent screen ----------

test('consent page names the client and redirect host, warns, escapes, and forbids framing', async () => {
  const { body: client } = await register(['https://app.partner.example/cb?x=1'], '<img src=x onerror=alert(1)>Totally Claude');
  assert.equal(client.client_name.includes('<'), false, 'angle brackets are stripped at registration');
  const { challenge } = await pkcePair();
  const q = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://app.partner.example/cb?x=1', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: '"><script>alert(1)</script>' });
  const res = await oauth(`/authorize?${q}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Totally Claude/);
  assert.match(html, /app\.partner\.example/);
  assert.match(html, /not verified/);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'state is escaped');
  assert.ok(!html.includes('<img src=x'));
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('consent errors render an error page and never redirect (wrong key, unknown client, bad PKCE request)', async () => {
  const { body: client } = await register();
  const { challenge } = await pkcePair();
  const wrong = await authorize({ clientId: client.client_id, challenge, key: OTHER_KEY });
  assert.equal(wrong.res.status, 200);
  assert.equal(wrong.location, null);
  assert.match(await wrong.res.text(), /Wrong access key/);
  const unknown = await authorize({ clientId: 'forged.client', challenge });
  assert.equal(unknown.location, null);
  assert.match(await unknown.res.text(), /Invalid authorization request/);
  // A client id signed by a different server key is a forgery.
  const foreign = await mintToken(OTHER_KEY, { t: 'client', r: [REDIRECT], n: 'x', iat: now() });
  assert.equal((await authorize({ clientId: foreign, challenge })).location, null);
  // A refresh token is not a client id.
  const notClient = await mintToken(KEY, { t: 'r', exp: now() + 100 });
  assert.equal((await authorize({ clientId: notClient, challenge })).location, null);
});

test('authorize rejects redirect_uri mismatch, bad PKCE parameters, wrong resource, and oversized state', async () => {
  const { body: client } = await register();
  const { challenge } = await pkcePair();
  const base = { client_id: client.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' };
  const get = async (over) => (await oauth(`/authorize?${new URLSearchParams({ ...base, ...over })}`)).text();
  assert.match(await get({}), /Authorize<\/button>/, 'sanity: the valid request shows the consent form');
  assert.match(await get({ redirect_uri: 'https://evil.example/cb' }), /Unknown client or redirect URI/);
  assert.match(await get({ redirect_uri: `${REDIRECT}/extra` }), /Unknown client or redirect URI/, 'exact match only');
  assert.match(await get({ redirect_uri: `${REDIRECT}?x=1` }), /Unknown client or redirect URI/);
  assert.match(await get({ redirect_uri: '' }), /Unknown client or redirect URI/);
  assert.match(await get({ code_challenge_method: 'plain' }), /S256 PKCE/);
  assert.match(await get({ code_challenge: 'short' }), /S256 PKCE/);
  assert.match(await get({ code_challenge: '' }), /S256 PKCE/);
  assert.match(await get({ response_type: 'token' }), /S256 PKCE/);
  assert.match(await get({ resource: 'https://other.example/mcp' }), /not this server/);
  assert.match(await get({ resource: MCP }), /Authorize<\/button>/, 'the right resource is fine');
  assert.match(await get({ resource: ORIGIN }), /Authorize<\/button>/);
  assert.match(await get({ state: 'x'.repeat(513) }), /state parameter is too long/);
  // The same checks apply on the POST that actually issues the code.
  const post = await authorize({ clientId: client.client_id, challenge, redirectUri: 'https://evil.example/cb' });
  assert.equal(post.location, null);
  const noKey = new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: 'short', access_key: KEY });
  assert.equal((await oauth('/authorize', { method: 'POST', body: noKey })).headers.get('Location'), null);
  // No access key configured on the server: OAuth is unusable, not open.
  const unconfigured = await oauth(`/authorize?${new URLSearchParams(base)}`, { key: '' });
  assert.equal(unconfigured.status, 400);
});

// ---------- the token endpoint ----------

test('token: client_id and redirect_uri are mandatory and must match the code', async () => {
  const { body: client } = await register();
  const other = (await register(['https://other.example/cb'], 'Other')).body;
  const { verifier, challenge } = await pkcePair();
  const { code } = await authorize({ clientId: client.client_id, challenge });
  const exchange = (over) => tokenReq({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier, ...over });
  const status = async (over) => { const r = await exchange(over); return [r.status, (await r.json()).error]; };
  assert.deepEqual(await status({ client_id: '' }), [400, 'invalid_request'], 'client_id is mandatory');
  assert.deepEqual(await status({ redirect_uri: '' }), [400, 'invalid_request'], 'redirect_uri is mandatory');
  assert.deepEqual(await status({ client_id: other.client_id }), [400, 'invalid_grant'], 'code is bound to the client that asked for it');
  assert.deepEqual(await status({ redirect_uri: 'https://other.example/cb' }), [400, 'invalid_grant'], 'redirect_uri must equal the authorization request');
  assert.deepEqual(await status({ redirect_uri: `${REDIRECT}/` }), [400, 'invalid_grant']);
  assert.deepEqual(await status({ code: 'x.y' }), [400, 'invalid_grant']);
  assert.deepEqual(await status({ code: '' }), [400, 'invalid_grant']);
  assert.equal((await exchange({})).status, 200, 'the untouched request succeeds');
});

test('token: PKCE is enforced (missing, wrong, malformed, and challenge-as-verifier)', async () => {
  const { body: client } = await register();
  const { verifier, challenge } = await pkcePair();
  const { code } = await authorize({ clientId: client.client_id, challenge });
  const exchange = (over) => tokenReq({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier, ...over });
  for (const bad of [{ code_verifier: '' }, { code_verifier: 'short' }, { code_verifier: (await pkcePair()).verifier }, { code_verifier: challenge }, { code_verifier: `${verifier}x` }]) {
    const r = await exchange(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal((await r.json()).error, 'invalid_grant');
  }
  const noVerifier = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT });
  assert.equal((await oauth('/token', { method: 'POST', body: noVerifier })).status, 400);
  assert.equal((await exchange({})).status, 200);
});

test('token: expired, forged, and wrong-type codes and refresh tokens are refused', async () => {
  const { body: client } = await register();
  const { verifier, challenge } = await pkcePair();
  const clientHash = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(client.client_id)));
  const mkCode = (key, over) => mintToken(key, { t: 'code', ci: clientHash, ru: REDIRECT, cc: challenge, aud: MCP, iat: now() - 400, exp: now() + 100, jti: 'j', ...over });
  const exchange = (code) => tokenReq({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal((await exchange(await mkCode(KEY, {}))).status, 200, 'sanity: a hand-minted valid code works');
  assert.equal((await exchange(await mkCode(KEY, { exp: now() - 1 }))).status, 400, 'expired code');
  assert.equal((await exchange(await mkCode(OTHER_KEY, {}))).status, 400, 'code signed by another key');
  assert.equal((await exchange(await mkCode(KEY, { aud: 'https://other.example/mcp' }))).status, 400, 'code for another resource');
  assert.equal((await exchange(await mkCode(KEY, { t: 'a' }))).status, 400, 'an access token is not a code');
  assert.equal((await exchange(await mkCode(KEY, { exp: undefined }))).status, 400, 'a code without expiry');
  // Refresh tokens.
  const mkRefresh = (over) => mintToken(KEY, { t: 'r', aud: MCP, ci: clientHash, oi: now() - 100, iat: now() - 100, exp: now() + 1000, ...over });
  const refresh = (token, cid = client.client_id) => tokenReq({ grant_type: 'refresh_token', refresh_token: token, client_id: cid });
  assert.equal((await refresh(await mkRefresh({}))).status, 200);
  assert.equal((await refresh(await mkRefresh({ exp: now() - 1 }))).status, 400, 'expired refresh token');
  assert.equal((await refresh(await mkRefresh({ t: 'a' }))).status, 400, 'an access token is not a refresh token');
  assert.equal((await refresh(await mkRefresh({ ci: 'someoneelse' }))).status, 400, 'refresh token bound to another client');
  assert.equal((await refresh(await mkRefresh({}), 'another-client-id')).status, 400, 'presented by another client');
  assert.equal((await refresh(await mkRefresh({ aud: 'https://other.example/mcp' }))).status, 400);
  assert.equal((await refresh(await mkRefresh({ oi: now() - MAX_SESSION - 10 }))).status, 400, 'beyond the absolute session cap');
  assert.equal((await refresh(await mkRefresh({ oi: undefined }))).status, 400, 'no session anchor');
  assert.equal((await refresh('forged')).status, 400);
  assert.equal((await tokenReq({ grant_type: 'password', client_id: 'x' })).status, 400);
  assert.equal((await oauth('/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code' }), key: '' })).status, 500, 'unconfigured server');
});

test('token: audience is this server; a code minted elsewhere cannot be redeemed here', async () => {
  const { body: client } = await register();
  const { verifier, challenge } = await pkcePair();
  const { code } = await authorize({ clientId: client.client_id, challenge });
  const r = await tokenReq({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: verifier }, 'https://evil.example');
  assert.equal(r.status, 400);
});

// ---------- registration ----------

test('registration: only https or loopback http redirect URIs', async () => {
  for (const ok of [REDIRECT, 'http://localhost:6274/oauth/callback', 'http://127.0.0.1:8080/cb', 'http://[::1]:9/cb']) {
    assert.equal(validRedirectUri(ok), true, ok);
    assert.equal((await register([ok])).res.status, 201, ok);
  }
  const rejected = [
    'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd', 'blob:https://x.example/abc',
    'http://evil.example/cb', 'http://localhost.evil.example/cb', 'http://127.0.0.1.evil.example/cb', 'ftp://x.example/cb',
    'https://user:pw@x.example/cb', 'https://x.example/cb#frag', 'https://', '//x.example/cb', '/relative', 'not a url', '', 'https://x.example/cb\nInjected: header',
    'cursor://anysphere.cursor-retrieval/oauth', 'myapp:/cb', 'https://' + 'a'.repeat(2100),
  ];
  for (const bad of rejected) {
    assert.equal(validRedirectUri(bad), false, bad);
    const { res } = await register([bad]);
    assert.equal(res.status, 400, bad);
  }
  assert.equal((await register([REDIRECT, 'javascript:alert(1)'])).res.status, 400, 'one bad URI rejects the registration');
  assert.equal((await register([])).res.status, 400);
  assert.equal((await register(Array.from({ length: 6 }, (_, i) => `https://x.example/cb${i}`))).res.status, 400);
  assert.equal((await oauth('/register', { method: 'POST', body: { redirect_uris: 'https://x.example/cb' } })).status, 400);
  assert.equal((await register([REDIRECT], 'x', undefined)).res.status, 201);
});

test('registration: custom schemes are off by default and opt-in via configuration, but never script/data', async () => {
  const opts = { extraRedirectSchemes: ['cursor', 'javascript', 'data', 'http', 'https'] };
  assert.equal((await register(['cursor://anysphere.cursor-retrieval/oauth'], 'Cursor', opts)).res.status, 201);
  assert.equal(validRedirectUri('cursor://x/cb', ['cursor']), true);
  assert.equal(validRedirectUri('CURSOR://x/cb', ['cursor']), true);
  assert.equal((await register(['javascript:alert(1)'], 'x', opts)).res.status, 400, 'javascript: can never be enabled');
  assert.equal((await register(['data:text/html,x'], 'x', opts)).res.status, 400);
  assert.equal((await register(['http://evil.example/cb'], 'x', opts)).res.status, 400, 'enabling schemes does not weaken the http rule');
});

test('registration: names are sanitized, and legacy-signed client ids still reach consent', async () => {
  const { body } = await register([REDIRECT], `  ${'N'.repeat(200)}\u0000\u0007  `);
  assert.equal(body.client_name.length, 80);
  assert.equal((await register([REDIRECT], '')).body.client_name, 'Unnamed MCP client');
  assert.equal((await register([REDIRECT], 42)).body.client_name, 'Unnamed MCP client');
  // A client id registered before the hardening (HMAC with the raw key) can still re-run consent.
  const data = Buffer.from(JSON.stringify({ t: 'client', r: [REDIRECT] })).toString('base64url');
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const legacyId = `${data}.${b64url(await crypto.subtle.sign('HMAC', raw, new TextEncoder().encode(data)))}`;
  const { challenge } = await pkcePair();
  const q = new URLSearchParams({ client_id: legacyId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' });
  const html = await (await oauth(`/authorize?${q}`)).text();
  assert.match(html, /Unnamed MCP client/);
  assert.match(html, /Authorize<\/button>/);
  // ...but a legacy-style client id with an unacceptable redirect URI does not.
  const dataBad = Buffer.from(JSON.stringify({ t: 'client', r: ['javascript:alert(1)'] })).toString('base64url');
  const badId = `${dataBad}.${b64url(await crypto.subtle.sign('HMAC', raw, new TextEncoder().encode(dataBad)))}`;
  const q2 = new URLSearchParams({ client_id: badId, redirect_uri: 'javascript:alert(1)', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' });
  assert.match(await (await oauth(`/authorize?${q2}`)).text(), /Unknown client or redirect URI/);
});

test('metadata documents advertise the pinned resource and S256 only', async () => {
  const as = await (await oauth('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  const pr = await (await oauth('/.well-known/oauth-protected-resource')).json();
  assert.equal(pr.resource, MCP);
  assert.equal(await oauth('/nope'), null);
});
