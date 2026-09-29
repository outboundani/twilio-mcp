// Live smoke test against a real Twilio account, exercising the tool layer
// directly (no Worker needed). Reads credentials from .env in the repo root
// (TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET).
//
// Read-only by default. Pass --writes to also build a small contact center
// from examples/main-line.json: a workspace, four queues, a workflow, and a
// DRAFT Studio flow, all MCP_Test_-prefixed and left in place (this server
// never deletes). It never places a call, sends a message, or touches a
// phone number, so it spends no trial credit.
import { readFileSync } from 'node:fs';
import { callTool } from '../src/tools.js';
import { TwilioClient } from '../src/twilio.js';
import { flowToSpec, normalizeSpec } from '../src/ivr.js';
import { isDeepStrictEqual } from 'node:util';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);

const cfg = {
  accountSid: env.TWILIO_ACCOUNT_SID,
  apiKeySid: env.TWILIO_API_KEY_SID,
  apiKeySecret: env.TWILIO_API_KEY_SECRET,
  configured: true,
};

const WRITES = process.argv.includes('--writes');
const stamp = new Date().toISOString().slice(5, 19).replace(/[-T:]/g, '');
let pass = 0, fail = 0;
const receipts = {};

async function step(name, fn, check = () => true) {
  try {
    const out = await fn();
    if (!check(out)) throw new Error(`check failed: ${JSON.stringify(out).slice(0, 400)}`);
    console.log(`PASS  ${name}`);
    pass++;
    return out;
  } catch (e) {
    console.log(`FAIL  ${name}: ${e.message}`);
    fail++;
    return null;
  }
}

const call = (name, args = {}) => callTool(cfg, name, args);
const refusedWith = (re) => async (fn) => {
  try { await fn(); return { refused: false }; } catch (e) { return { refused: re.test(e.message), message: e.message }; }
};

// ---------- reads ----------
await step('check_connection', () => call('check_connection'), (o) => o.ok && o.account_sid === cfg.accountSid);
await step('about', () => call('about'), (o) => typeof o === 'string' && o.includes('API landmines'));
await step('list_phone_numbers', () => call('list_phone_numbers'), (o) => 'total' in o);
await step('list_workspaces', () => call('list_workspaces'), (o) => 'total' in o);
await step('list_flows', () => call('list_flows'), (o) => 'total' in o);
await step('contact_center_overview', () => call('contact_center_overview'), (o) => Array.isArray(o.checks));
await step('twilio_api_call GET account (auth_token redacted)', () => call('twilio_api_call', { host: 'api', method: 'GET', path: `2010-04-01/Accounts/${cfg.accountSid}.json` }),
  (o) => o.sid === cfg.accountSid && (o.auth_token === undefined || o.auth_token === '' || o.auth_token === '[redacted]'));

// ---------- refusal rails (none of these reach the network) ----------
const R = (label, re, args) => step(`refuses ${label}`, () => refusedWith(re)(() => call('twilio_api_call', args)), (o) => o.refused);
await R('a Studio Execution (it places a call)', /places a real outbound call/, { host: 'studio', method: 'POST', path: `v2/Flows/FW${'0'.repeat(32)}/Executions`, body: { To: '+15555550100', From: '+15555550101' } });
await R('the Calls API', /never places/, { host: 'api', method: 'POST', path: `2010-04-01/Accounts/${cfg.accountSid}/Calls.json`, body: { To: '+15555550100' } });
await R('the Messages API', /never sends messages/, { host: 'api', method: 'POST', path: `2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, body: { To: '+15555550100', Body: 'hi' } });
await R('repointing a phone number', /never changes a phone number/, { host: 'api', method: 'POST', path: `2010-04-01/Accounts/${cfg.accountSid}/IncomingPhoneNumbers/PN${'0'.repeat(32)}.json`, body: { VoiceUrl: 'https://example.com' } });
await R('buying a number', /never buys numbers/, { host: 'api', method: 'GET', path: `2010-04-01/Accounts/${cfg.accountSid}/AvailablePhoneNumbers/US/Local.json` });
await R('a traversal into Executions', /segments/, { host: 'studio', method: 'POST', path: 'v2/Flows/x/../Executions' });
await R('a lookalike host', /host must be one of/, { host: 'studio.twilio.com.evil.com', method: 'GET', path: 'v2/Flows' });

if (!WRITES) {
  console.log(`\n${pass} passed, ${fail} failed (read-only; pass --writes to build the MCP_Test_ contact center)`);
  process.exit(fail ? 1 : 0);
}

// ---------- writes: build the example contact center ----------
const P = 'MCP_Test_';
const example = JSON.parse(readFileSync(new URL('../examples/main-line.json', import.meta.url), 'utf8'));
const spec = JSON.parse(JSON.stringify(example).replace(/"queue": ?"([A-Za-z_]+)"/g, (_, q) => `"queue":"${P}${q}"`));
spec.name = `${P}Main_Line_${stamp}`;
const wsName = `${P}Contact_Center_${stamp}`;
const wfName = `${P}Main_Line_Routing`;

const ws = await step(`create_workspace ${wsName}`, () => call('create_workspace', { name: wsName }), (o) => o.created && o.sid.startsWith('WS'));
receipts.workspace = ws && { name: ws.name, sid: ws.sid, activities: ws.activities };
await step('create_workspace refuses a duplicate name', () => refusedWith(/already exists/)(() => call('create_workspace', { name: wsName })), (o) => o.refused);
await step('list_activities (Twilio seeds + Unavailable + Break, exactly one ready state)', () => call('list_activities', { workspace: wsName }),
  (o) => ['Offline', 'Busy', 'Reserved', 'Unavailable', 'Break'].every((n) => o.activities.some((a) => a.name === n)) && o.activities.filter((a) => a.available).length === 1);
const q1 = await step(`create_task_queue ${P}Sales`, () => call('create_task_queue', { workspace: wsName, name: `${P}Sales` }), (o) => o.created && o.target_workers === `skills HAS '${P}Sales'`);
const wf = await step(`create_workflow ${wfName} from the spec (creates the missing queues)`, () => call('create_workflow', { workspace: wsName, name: wfName, spec, create_missing_queues: true }),
  (o) => o.created && o.routes.length === 4 && o.queues_created.length === 3);
await step('create_workflow refuses a duplicate name', () => refusedWith(/already exists/)(() => call('create_workflow', { workspace: wsName, name: wfName, spec })), (o) => o.refused);
const qs = await step('list_task_queues (4 queues)', () => call('list_task_queues', { workspace: wsName }), (o) => o.total === 4);
receipts.task_queues = qs?.task_queues.map((q) => ({ name: q.name, sid: q.sid, target_workers: q.target_workers }));
await step('list_workflows (each route: selected_queue == queue -> that queue)', () => call('list_workflows', { workspace: wsName }),
  (o) => o.workflows[0].routes.every((r) => r.expression === `selected_queue == '${r.queues[0]}'`));
receipts.workflow = wf && { name: wf.name, sid: wf.sid, routes: wf.routes.map((r) => `${r.expression} -> ${r.queues.join(',')}`) };
receipts.queue_created_directly = q1 && q1.sid;
await step('list_workers (none yet)', () => call('list_workers', { workspace: wsName }), (o) => o.total === 0);

await step('render_flow (spec preview)', () => call('render_flow', { spec }), (o) => o.valid && o.mermaid.startsWith('flowchart TD') && o.gaps.length === 1);
await step('build_ivr dry_run (Twilio Validate, nothing created)', () => call('build_ivr', { spec, workspace: wsName, dry_run: true }),
  (o) => o.valid && o.created === false && o.workflow?.sid === wf?.sid);
const bad = JSON.parse(JSON.stringify(spec));
bad.menu.options[0].action.queue = `${P}Nowhere`;
await step('build_ivr refuses an unrouted queue before sending anything', () => call('build_ivr', { spec: bad, workspace: wsName }), (o) => o.valid === false && o.stage === 'routing');

const flow = await step(`build_ivr ${spec.name} (draft)`, () => call('build_ivr', { spec, workspace: wsName }),
  (o) => o.created && o.status === 'draft' && o.sid.startsWith('FW') && o.live === false && o.gaps[0].startsWith('hours'));
receipts.flow = flow && { name: flow.name, sid: flow.sid, status: flow.status, revision: flow.revision, webhook_url: flow.webhook_url, widgets: flow.widgets, twilio_valid: flow.twilio_valid };
await step('build_ivr refuses the same name again', () => call('build_ivr', { spec, workspace: wsName }), (o) => /already exists/.test(o.error || ''));

if (flow) {
  const tw = new TwilioClient(cfg);
  const stored = await tw.get('studio', `v2/Flows/${flow.sid}`);
  await step('read-back: Twilio stored it as a valid draft, on no number', () => call('get_flow', { flow: flow.sid }),
    (o) => o.status === 'draft' && o.valid === true && o.live_on_numbers.length === 0 && o.widgets.length === flow.widgets);
  await step('read-back ROUND TRIP: the SERVER-STORED definition exports to the exact spec', async () => {
    const back = flowToSpec(stored.definition, { name: stored.friendly_name });
    return { equal: isDeepStrictEqual(back.spec, normalizeSpec(spec)), lossy: back.lossy };
  }, (o) => o.equal && o.lossy.length === 0);
  await step('export_ivr_spec (the migration beat) equals the spec', () => call('export_ivr_spec', { flow: spec.name }),
    (o) => isDeepStrictEqual(o.spec, normalizeSpec(spec)) && o.lossy.length === 0);
  await step('re-Validate the stored definition with Twilio', () => call('twilio_api_call', {
    host: 'studio', method: 'POST', path: 'v2/Flows/Validate',
    body: { FriendlyName: stored.friendly_name, Status: 'draft', Definition: stored.definition },
  }), (o) => o.valid === true);
  await step('render_flow (stored flow, widget view)', () => call('render_flow', { flow: flow.sid }), (o) => o.mermaid.startsWith('flowchart TD'));
  await step('render_flow (stored flow, spec view)', () => call('render_flow', { flow: flow.sid, as_spec: true }), (o) => o.lossy.length === 0);
  await step('twilio_api_call GET revisions', () => call('twilio_api_call', { host: 'studio', method: 'GET', path: `v2/Flows/${flow.sid}/Revisions` }), (o) => o.revisions?.length >= 1);
  await step('twilio_api_call refuses publishing over the flow', () => refusedWith(/only with Status "draft"/)(() => call('twilio_api_call', {
    host: 'studio', method: 'POST', path: `v2/Flows/${flow.sid}`, body: { Status: 'published' },
  })), (o) => o.refused);
  await step('twilio_api_call refuses an Execution on the new flow', () => refusedWith(/places a real outbound call/)(() => call('twilio_api_call', {
    host: 'studio', method: 'POST', path: `v2/Flows/${flow.sid}/Executions`, body: { To: '+15555550100', From: '+15555550101' },
  })), (o) => o.refused);
  const ov = await step('contact_center_overview sees the whole build, and nothing live', () => call('contact_center_overview'), (o) => {
    const f = o.flows.find((x) => x.sid === flow.sid);
    return f && f.enqueues.length === 4 && f.enqueues.every((e) => e.workflow?.startsWith(wfName)) && f.live_on_numbers.length === 0;
  });
  if (ov) receipts.overview_checks = ov.checks;
}

console.log('\nRECEIPTS (left in place on purpose; this server never deletes):');
console.log(JSON.stringify(receipts, null, 2));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
