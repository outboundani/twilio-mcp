// HTTP surface tests: body and batch caps, generic errors, Origin handling,
// page headers. They drive the Worker's fetch() directly (no network, no KV).
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleMessage, originAllowed, MAX_BODY_BYTES, MAX_BATCH } from '../src/index.js';
import { TwilioClient } from '../src/twilio.js';

const BASE = 'https://mcp.example.test';
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const post = (body, { headers = {}, path = '/mcp', raw } = {}) =>
  new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body) });
const call = (req, env = {}) => worker.fetch(req, env);

test('F7: a normal JSON-RPC call works (server unconfigured = open, fail-closed rules are in checkAuth tests)', async () => {
  const res = await call(post(rpc(1, 'ping')));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).result, {});
});

test('F7: bodies over the cap are refused with 413, declared or streamed', async () => {
  const big = JSON.stringify(rpc(1, 'ping', { pad: 'x'.repeat(MAX_BODY_BYTES) }));
  let res = await call(post(null, { raw: big }));
  assert.equal(res.status, 413, 'streamed body over the cap (no usable Content-Length)');
  res = await call(post(rpc(1, 'ping'), { headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } }));
  assert.equal(res.status, 413, 'declared length over the cap');
  // The cap covers the OAuth and setup endpoints too.
  res = await call(new Request(`${BASE}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=authorization_code&junk=${'a'.repeat(MAX_BODY_BYTES)}` }));
  assert.equal(res.status, 413);
  res = await call(post(null, { path: '/setup', raw: big }));
  assert.equal(res.status, 413);
  // Just under the cap is fine.
  res = await call(post(null, { raw: JSON.stringify(rpc(1, 'ping', { pad: 'x'.repeat(MAX_BODY_BYTES - 200) })) }));
  assert.equal(res.status, 200);
});

test('F7: JSON-RPC batches are capped at 10 and may not be empty', async () => {
  const msgs = (n) => Array.from({ length: n }, (_, i) => rpc(i + 1, 'ping'));
  let res = await call(post(msgs(MAX_BATCH)));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).length, MAX_BATCH);
  res = await call(post(msgs(MAX_BATCH + 1)));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32600);
  res = await call(post([]));
  assert.equal(res.status, 400);
});

test('F7: unexpected exceptions return generic text, never the exception message', async () => {
  const cfg = { get configured() { throw new Error('boom with secret SK0123456789abcdef'); } };
  const out = await handleMessage(rpc(7, 'tools/call', { name: 'check_connection', arguments: {} }), cfg);
  assert.equal(out.error.code, -32603);
  assert.equal(out.error.message, 'Internal error');
  assert.ok(!JSON.stringify(out).includes('SK0123'));
  // Known tool errors still explain themselves (and are redacted).
  const known = await handleMessage(rpc(8, 'tools/call', { name: 'nope' }), { configured: false });
  assert.match(known.result.content[0].text, /Unknown tool/);
});

test('F7: a 2xx response that is not a JSON object is an error, not a success', async () => {
  const tw = new TwilioClient({ accountSid: `AC${'1'.repeat(32)}`, apiKeySid: `SK${'9'.repeat(32)}`, apiKeySecret: 's' });
  globalThis.fetch = async () => new Response('<html>captive portal</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(tw.get('studio', 'v2/Flows'), (e) => e.status === 502 && /not a JSON object/.test(e.message));
  globalThis.fetch = async () => new Response('[1,2]', { status: 200 });
  await assert.rejects(tw.get('studio', 'v2/Flows'), /not a JSON object/);
  globalThis.fetch = async () => new Response('', { status: 200 });
  assert.deepEqual(await tw.get('studio', 'v2/Flows'), { ok: true }, 'an empty 200 is still fine');
  // A non-JSON error response stays an error and does not echo the raw body.
  globalThis.fetch = async () => new Response('<html>Bad gateway SECRETISH</html>', { status: 502 });
  await assert.rejects(tw.get('studio', 'v2/Flows'), (e) => /HTTP 502/.test(e.message) && !/SECRETISH/.test(e.message));
});

test('F7: Origin handling on /mcp: absent is fine, unknown browser origins are rejected, extras are configurable', async () => {
  const withOrigin = (origin, env) => call(post(rpc(1, 'ping'), { headers: origin === null ? {} : { Origin: origin } }), env);
  assert.equal((await withOrigin(null)).status, 200, 'server-side clients send no Origin');
  assert.equal((await withOrigin(BASE)).status, 200, 'same origin');
  assert.equal((await withOrigin('https://claude.ai')).status, 200);
  assert.equal((await withOrigin('https://chatgpt.com')).status, 200);
  assert.equal((await withOrigin('http://localhost:6274')).status, 200, 'local dev (MCP Inspector)');
  assert.equal((await withOrigin('http://127.0.0.1:3000')).status, 200);
  for (const bad of ['https://evil.example', 'null', 'https://claude.ai.evil.example', 'http://localhost.evil.example', 'https://localhost:3000', 'not a url']) {
    const res = await withOrigin(bad);
    assert.equal(res.status, 403, bad);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null, 'no CORS grant for a rejected origin');
  }
  assert.equal((await withOrigin('https://app.example.org', { MCP_ALLOWED_ORIGINS: 'https://app.example.org, https://x.example' })).status, 200);
  assert.equal((await withOrigin('https://evil.example', { MCP_ALLOWED_ORIGINS: 'https://app.example.org' })).status, 403);
  assert.equal((await withOrigin('https://anything.example', { MCP_ALLOWED_ORIGINS: '*' })).status, 200, '* disables the check');
  // Allowed browser origins are echoed (not "*") on the MCP endpoint.
  const ok = await withOrigin('https://claude.ai');
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://claude.ai');
  assert.match(ok.headers.get('Vary'), /Origin/);
  assert.equal(originAllowed(new Request(BASE, { headers: {} }), new URL(BASE), {}), true);
});

test('F7: HTML pages carry anti-framing headers; JSON endpoints carry nosniff', async () => {
  for (const path of ['/', '/setup']) {
    const res = await call(new Request(`${BASE}${path}`), {});
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY', path);
    assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/, path);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
  const health = await call(new Request(`${BASE}/health`), {});
  assert.equal(health.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('F7: a crash inside routing becomes a generic 500', async () => {
  const env = { get CONFIG() { throw new Error('kv exploded with SECRETVALUE'); } };
  const res = await call(new Request(`${BASE}/health`), env);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'Internal error' });
});
