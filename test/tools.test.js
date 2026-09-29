// Tool-layer tests against an in-memory Twilio stub (no real traffic). They
// prove the rails run BEFORE any network call, that only validated values
// reach the wire, and that build_ivr's order is: route check -> Validate ->
// create (draft).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callTool, toolDefs, flowSidFromUrl, WRITE_TOOLS, TOOL_GROUPS } from '../src/tools.js';
import { TwilioClient } from '../src/twilio.js';
import { flowToSpec, normalizeSpec } from '../src/ivr.js';

const AC = `AC${'1'.repeat(32)}`;
const WS = `WS${'4'.repeat(32)}`;
const WW = `WW${'6'.repeat(32)}`;
const FW = `FW${'3'.repeat(32)}`;
const EXAMPLE = JSON.parse(readFileSync(new URL('../examples/main-line.json', import.meta.url), 'utf8'));
const cfg = { configured: true, accountSid: AC, apiKeySid: `SK${'9'.repeat(32)}`, apiKeySecret: 's' };

// A tiny fake Twilio. `routes` maps "METHOD host/path" to a handler.
function stub(routes = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const form = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : undefined;
    calls.push({ method, host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), form, auth: init.headers?.Authorization });
    const key = `${method} ${url.host}${url.pathname}`;
    const h = routes[key];
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (!h) return reply({ code: 20404, message: `stub has no route for ${key}`, status: 404 }, 404);
    const out = await h({ form, url });
    return out.__status ? reply(out.body, out.__status) : reply(out);
  };
  return calls;
}

const queues = ['Sales', 'Support', 'Support_Escalations', 'Billing'].map((n, i) => ({ sid: `WQ${String(i).repeat(32)}`, friendly_name: n, target_workers: `skills HAS '${n}'` }));
const routedConfig = (names) => JSON.stringify({
  task_routing: {
    filters: names.map((n) => ({ filter_friendly_name: n, expression: `selected_queue == '${n}'`, targets: [{ queue: queues.find((q) => q.friendly_name === n).sid }] })),
    default_filter: { queue: queues[0].sid },
  },
});

function twilioWorld({ routed = queues.map((q) => q.friendly_name), flows = [], numbers = [], validate } = {}) {
  let created = null;
  const routes = {
    'GET taskrouter.twilio.com/v1/Workspaces': () => ({ workspaces: [{ sid: WS, friendly_name: 'MCP_Test_WS' }], meta: { next_page_url: null } }),
    [`GET taskrouter.twilio.com/v1/Workspaces/${WS}/Workflows`]: () => ({ workflows: [{ sid: WW, friendly_name: 'MCP_Test_Routing', configuration: routedConfig(routed) }], meta: {} }),
    [`GET taskrouter.twilio.com/v1/Workspaces/${WS}/TaskQueues`]: () => ({ task_queues: queues, meta: {} }),
    'POST studio.twilio.com/v2/Flows/Validate': validate || (() => ({ valid: true })),
    'GET studio.twilio.com/v2/Flows': () => ({ flows, meta: {} }),
    'POST studio.twilio.com/v2/Flows': ({ form }) => {
      created = { sid: FW, friendly_name: form.FriendlyName, status: form.Status, revision: 1, valid: true, warnings: [], webhook_url: `https://webhooks.twilio.com/v1/Accounts/${AC}/Flows/${FW}`, definition: JSON.parse(form.Definition) };
      return created;
    },
    [`POST studio.twilio.com/v2/Flows/${FW}`]: ({ form }) => ({ sid: FW, friendly_name: 'x', status: form.Status, revision: 2, webhook_url: 'w' }),
    [`GET api.twilio.com/2010-04-01/Accounts/${AC}/IncomingPhoneNumbers.json`]: () => ({ incoming_phone_numbers: numbers, next_page_uri: null }),
    [`GET api.twilio.com/2010-04-01/Accounts/${AC}.json`]: () => ({ sid: AC, friendly_name: 'Test', auth_token: 'SECRET', status: 'active', type: 'Trial' }),
  };
  return { routes, created: () => created };
}

const BYPASSES = [
  { host: 'studio', method: 'POST', path: `v2/Flows/${FW}/Executions`, body: { To: '+15555550100', From: '+15555550101' } },
  { host: 'studio', method: 'POST', path: `v2/Flows/${FW}/x/../Executions` },
  { host: 'studio', method: 'POST', path: `v2/Flows/${FW}/Execution%73` },
  { host: 'api', method: 'POST', path: `2010-04-01/Accounts/${AC}/Calls.json`, body: { To: '+15555550100' } },
  { host: 'api', method: 'POST', path: `2010-04-01/Accounts/${AC}/Messages.json`, body: { Body: 'hi' } },
  { host: 'api', method: 'POST', path: `2010-04-01/Accounts/${AC}/IncomingPhoneNumbers/PN${'7'.repeat(32)}.json`, body: { VoiceUrl: 'x' } },
  { host: 'studio.twilio.com.evil.com', method: 'GET', path: 'v2/Flows' },
  { host: 'studio', method: 'GET', path: '//evil.com/v2/Flows' },
  { host: 'api', method: 'GET', path: `2010-04-01/Accounts/AC${'2'.repeat(32)}.json` },
  { host: 'studio', method: 'POST', path: `v2/Flows/${FW}`, body: { Status: 'published' } },
  { host: 'taskrouter', method: 'POST', path: 'v1/Workspaces', body: { FriendlyName: 'x', EventCallbackUrl: 'https://evil.example' } },
];

test('twilio_api_call refuses every known bypass before any network call', async () => {
  const calls = stub();
  for (const args of BYPASSES) {
    await assert.rejects(callTool(cfg, 'twilio_api_call', args), (e) => /^Refused|Invalid arguments/.test(e.message), JSON.stringify(args));
  }
  // DELETE is not even in the schema enum; validateArgs stops it first.
  await assert.rejects(callTool(cfg, 'twilio_api_call', { host: 'studio', method: 'DELETE', path: `v2/Flows/${FW}` }), /Invalid arguments/);
  assert.equal(calls.length, 0);
});

test('twilio_api_call sends only the validated values, over Basic auth, and redacts secrets', async () => {
  const w = twilioWorld();
  const calls = stub(w.routes);
  const res = await callTool(cfg, 'twilio_api_call', { host: 'api.twilio.com', method: 'GET', path: `/2010-04-01/Accounts/${AC}.json` });
  assert.equal(res.auth_token, '[redacted]');
  assert.equal(res.friendly_name, 'Test');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, 'api.twilio.com');
  assert.equal(calls[0].path, `/2010-04-01/Accounts/${AC}.json`);
  assert.equal(calls[0].auth, `Basic ${btoa(`${cfg.apiKeySid}:s`)}`);
});

test('the HTTP client itself refuses DELETE, calls, messages, numbers, and executions (typed tools included)', async () => {
  const calls = stub();
  const tw = new TwilioClient(cfg);
  await assert.rejects(tw.request('studio', 'DELETE', `v2/Flows/${FW}`), /no deletes/);
  await assert.rejects(tw.request('studio', 'PUT', 'v2/Flows'), /not used/);
  await assert.rejects(tw.post('api', tw.acct('/Calls.json'), { To: '+15555550100' }), /outside this server's write allowlist/);
  await assert.rejects(tw.post('api', tw.acct('/Messages.json'), { Body: 'x' }), /outside this server's write allowlist/);
  await assert.rejects(tw.post('api', tw.acct(`/IncomingPhoneNumbers/PN${'7'.repeat(32)}.json`), { VoiceUrl: 'x' }), /outside this server's write allowlist/);
  await assert.rejects(tw.post('studio', `v2/Flows/${FW}/Executions`, { To: 'x' }), /outside this server's write allowlist/);
  await assert.rejects(tw.post('taskrouter', `v1/Workspaces/${WS}/Tasks`, {}), /outside this server's write allowlist/);
  await assert.rejects(tw.get('studio', 'v2/Flows/../Flows'), /does not survive URL parsing/);
  await assert.rejects(tw.get('studio', 'v2/Flows?x=1'), /does not survive URL parsing/);
  await assert.rejects(tw.get('evil', 'v2/Flows'), /unknown host/);
  assert.equal(calls.length, 0);
});

test('pagination never follows a next-page link off the pinned host', async () => {
  const calls = stub({
    'GET studio.twilio.com/v2/Flows': () => ({ flows: [{ sid: FW }], meta: { next_page_url: 'https://evil.example/v2/Flows?Page=1' } }),
  });
  const tw = new TwilioClient(cfg);
  const r = await tw.listAll('studio', 'v2/Flows', 'flows');
  assert.equal(r.entities.length, 1);
  assert.equal(calls.length, 1);
});

test('build_ivr: route check -> Twilio Validate -> create as DRAFT, and the saved flow exports back to the spec', async () => {
  const w = twilioWorld();
  const calls = stub(w.routes);
  const res = await callTool(cfg, 'build_ivr', { spec: EXAMPLE });
  assert.equal(res.valid, true, JSON.stringify(res));
  assert.equal(res.created, true);
  assert.equal(res.status, 'draft');
  assert.equal(res.live, false);
  assert.ok(res.gaps[0].startsWith('hours is not supported'));
  assert.match(res.mermaid, /^flowchart TD/);
  const order = calls.filter((c) => c.method === 'POST').map((c) => c.path);
  assert.deepEqual(order, ['/v2/Flows/Validate', '/v2/Flows'], 'Validate runs first, then exactly one create');
  const posted = calls.find((c) => c.method === 'POST' && c.path === '/v2/Flows').form;
  assert.equal(posted.Status, 'draft');
  const def = JSON.parse(posted.Definition);
  assert.ok(def.states.filter((s) => s.type === 'enqueue-call').every((s) => s.properties.workflow_sid === WW));
  assert.deepEqual(flowToSpec(def, { name: EXAMPLE.name }).spec, normalizeSpec(EXAMPLE));
  // No write ever touched api.twilio.com.
  assert.ok(!calls.some((c) => c.method !== 'GET' && c.host === 'api.twilio.com'));
});

test('build_ivr publish: true publishes a NEW flow (harmless: nothing points at it)', async () => {
  const w = twilioWorld();
  const calls = stub(w.routes);
  const res = await callTool(cfg, 'build_ivr', { spec: EXAMPLE, publish: true });
  assert.equal(res.status, 'published');
  assert.equal(calls.find((c) => c.path === '/v2/Flows' && c.method === 'POST').form.Status, 'published');
});

test('build_ivr refuses before sending anything when the workflow does not route a queue', async () => {
  const w = twilioWorld({ routed: ['Sales', 'Billing'] });
  const calls = stub(w.routes);
  const res = await callTool(cfg, 'build_ivr', { spec: EXAMPLE });
  assert.equal(res.valid, false);
  assert.equal(res.stage, 'routing');
  assert.ok(res.errors.some((e) => e.includes("selected_queue == 'Support'")));
  assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing posted, not even Validate');
});

test('build_ivr relays Twilio Validate errors verbatim and creates nothing', async () => {
  const details = { errors: [{ message: 'must match a widget name', property_path: '#/states/0/transitions/0/next' }], warnings: [] };
  const w = twilioWorld({ validate: () => ({ __status: 400, body: { code: 81022, message: 'Flow definition validation failed, check `details` for more information', status: 400, details } }) });
  const calls = stub(w.routes);
  const res = await callTool(cfg, 'build_ivr', { spec: EXAMPLE });
  assert.equal(res.valid, false);
  assert.equal(res.stage, 'twilio_validate');
  assert.deepEqual(res.twilio_errors, details.errors);
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path === '/v2/Flows'));
});

test('build_ivr dry_run validates with Twilio and creates nothing', async () => {
  const w = twilioWorld();
  const calls = stub(w.routes);
  const res = await callTool(cfg, 'build_ivr', { spec: EXAMPLE, dry_run: true });
  assert.equal(res.valid, true);
  assert.equal(res.created, false);
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.path), ['/v2/Flows/Validate']);
});

test('build_ivr: existing names are identity; replace_draft saves a draft; publishing over a LIVE flow is refused', async () => {
  const existing = [{ sid: FW, friendly_name: 'Main_Line', status: 'published' }];
  const live = [{ sid: `PN${'7'.repeat(32)}`, phone_number: '+15555550100', voice_url: `https://webhooks.twilio.com/v1/Accounts/${AC}/Flows/${FW}` }];

  let calls = stub(twilioWorld({ flows: existing }).routes);
  let res = await callTool(cfg, 'build_ivr', { spec: EXAMPLE });
  assert.match(res.error, /already exists/);
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path.startsWith('/v2/Flows/FW')));

  calls = stub(twilioWorld({ flows: existing, numbers: live }).routes);
  res = await callTool(cfg, 'build_ivr', { spec: EXAMPLE, replace_draft: true });
  assert.equal(res.updated, true);
  assert.equal(calls.find((c) => c.path === `/v2/Flows/${FW}`).form.Status, 'draft');

  calls = stub(twilioWorld({ flows: existing, numbers: live }).routes);
  res = await callTool(cfg, 'build_ivr', { spec: EXAMPLE, replace_draft: true, publish: true });
  assert.match(res.error, /\+15555550100 point at "Main_Line"/);
  assert.ok(!calls.some((c) => c.path === `/v2/Flows/${FW}` && c.method === 'POST'));
});

test('render_flow and about need no Twilio connection; argument validation is enforced', async () => {
  const calls = stub();
  const off = { configured: false };
  const r = await callTool(off, 'render_flow', { spec: EXAMPLE });
  assert.equal(r.valid, true);
  assert.match(await callTool(off, 'about'), /API landmines/);
  await assert.rejects(callTool(off, 'list_flows'), /not connected to Twilio/);
  await assert.rejects(callTool(cfg, 'build_ivr', { spec: EXAMPLE, surprise: 1 }), /not a known argument/);
  await assert.rejects(callTool(cfg, 'create_task_queue', {}), /name is required/);
  assert.equal(calls.length, 0);
});

test('flowSidFromUrl only recognizes real Studio webhook URLs', () => {
  assert.equal(flowSidFromUrl(`https://webhooks.twilio.com/v1/Accounts/${AC}/Flows/${FW}`), FW);
  assert.equal(flowSidFromUrl(`https://webhooks.twilio.com/v1/Accounts/${AC}/Flows/${FW}?x=1`), FW);
  assert.equal(flowSidFromUrl(`https://evil.example/v1/Accounts/${AC}/Flows/${FW}`), null);
  assert.equal(flowSidFromUrl('https://demo.twilio.com/welcome/voice/'), null);
  assert.equal(flowSidFromUrl(null), null);
});

test('registry: every tool is grouped once, writes are flagged, no delete/call/send tools exist', () => {
  const names = toolDefs().map((t) => t.name);
  const grouped = TOOL_GROUPS.flatMap((g) => g.tools);
  assert.deepEqual([...grouped].sort(), [...names].sort());
  for (const w of WRITE_TOOLS) assert.ok(names.includes(w), w);
  assert.ok(!names.some((n) => /delete|remove|release|purchase|buy|call_number|dial|send|execute|repoint|publish_flow/.test(n)), names.join(','));
});
