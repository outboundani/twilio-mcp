// The raw-API guard (normalize, then ALLOWLIST) and the client write gate.
// Every "BYPASS" test is an attack shape the ringcx-mcp audit proved against
// a blocklist guard, re-aimed at Twilio. They must all stay refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRawCall, isAllowedWrite, redactSecrets, validateArgs, resolveHost, definitionProblems } from '../src/rules.js';

const AC = `AC${'1'.repeat(32)}`;
const OTHER = `AC${'2'.repeat(32)}`;
const FW = `FW${'3'.repeat(32)}`;
const WS = `WS${'4'.repeat(32)}`;
const WQ = `WQ${'5'.repeat(32)}`;
const WW = `WW${'6'.repeat(32)}`;
const PN = `PN${'7'.repeat(32)}`;
const FN = `FN${'8'.repeat(32)}`;
const ctx = { accountSid: AC };

const check = (a) => checkRawCall(a, ctx);
const refused = (a, re) => {
  const r = check(a);
  assert.equal(r.ok, false, `expected refusal: ${JSON.stringify(a)}`);
  if (re) assert.match(r.message, re, JSON.stringify(a));
};
const allowed = (a) => {
  const r = check(a);
  assert.ok(r.ok, `expected allowed: ${JSON.stringify(a)} -> ${r.message}`);
  return r;
};
const minimalDef = { states: [{ name: 'Trigger', type: 'trigger', properties: {}, transitions: [] }], initial_state: 'Trigger' };

test('host pinning: only the three official hosts, no lookalikes or overrides', () => {
  assert.equal(resolveHost('studio'), 'studio');
  assert.equal(resolveHost('STUDIO.twilio.com'), 'studio');
  for (const h of ['studio.twilio.com.evil.com', 'evil.com', 'https://studio.twilio.com', 'studio.twilio.com:443', 'api.twilio.com@evil.com',
    'voice.twilio.com', 'conversations.twilio.com', 'messaging.twilio.com', 'studio.twilio.co', '', null]) {
    assert.equal(resolveHost(h), null, String(h));
    if (h) refused({ host: h, method: 'GET', path: 'v2/Flows' }, /host must be one of/);
  }
});

test('BYPASS: traversal, encoding, matrix, and smuggled query/fragment paths are refused', () => {
  const paths = [
    'v2/Flows/../Flows', `v2/Flows/${FW}/../../Flows`, 'v2/./Flows', '//evil.com/v2/Flows', 'v2//Flows',
    'v2/Flows%2f..%2fExecutions', 'v2/%46lows', 'v2/Flows;x=1', 'v2\\Flows', 'v2/Flows?Status=published', 'v2/Flows#x',
    'v2/Flows /x', 'v2/Flows/..', 'v2/Flows/.', 'v2/Flo:ws', 'v2/Flows.', 'v2/Flows/.hidden',
  ];
  for (const p of paths) refused({ host: 'studio', method: 'GET', path: p });
  // A POST that would reach Executions via traversal never gets to the allowlist.
  refused({ host: 'studio', method: 'POST', path: `v2/Flows/${FW}/x/../Executions`, body: { To: '+15555550100', From: '+15555550101' } });
});

test('deletes and non-Twilio verbs are refused', () => {
  refused({ host: 'studio', method: 'DELETE', path: `v2/Flows/${FW}` }, /no deletes/);
  refused({ host: 'taskrouter', method: 'delete', path: `v1/Workspaces/${WS}` }, /no deletes/);
  for (const m of ['PUT', 'PATCH', 'HEAD', 'OPTIONS', '', undefined]) refused({ host: 'studio', method: m, path: 'v2/Flows' }, /not allowed/);
});

test('never dials: calls, conferences, and Studio Executions (read or write, any casing)', () => {
  refused({ host: 'api', method: 'POST', path: `2010-04-01/Accounts/${AC}/Calls.json`, body: { To: '+15555550100' } }, /never places/);
  refused({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${AC}/Calls.json` }, /never places/);
  refused({ host: 'api', method: 'POST', path: `2010-04-01/Accounts/${AC}/calls.JSON` }, /never places/);
  refused({ host: 'api', method: 'POST', path: `2010-04-01/Accounts/${AC}/Conferences/CF${'0'.repeat(32)}/Participants.json` }, /never places/);
  refused({ host: 'studio', method: 'POST', path: `v2/Flows/${FW}/Executions`, body: { To: '+15555550100', From: '+15555550101' } }, /places a real outbound call/);
  refused({ host: 'studio', method: 'POST', path: `v2/Flows/${FW}/executions` }, /places a real outbound call/);
  refused({ host: 'studio', method: 'POST', path: `v2/Flows/${FW}/Executions/${FN}`, body: { Status: 'ended' } }, /places a real outbound call/);
  allowed({ host: 'studio', method: 'GET', path: `v2/Flows/${FW}/Executions` });
  allowed({ host: 'studio', method: 'GET', path: `v2/Flows/${FW}/Executions/${FN}/Steps` });
});

test('never sends: messages, SMS, conversations', () => {
  refused({ host: 'api', method: 'POST', path: `2010-04-01/Accounts/${AC}/Messages.json`, body: { To: '+15555550100', Body: 'hi' } }, /never sends messages/);
  refused({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${AC}/SMS/ShortCodes.json` }, /never sends messages/);
  refused({ host: 'conversations.twilio.com', method: 'POST', path: 'v1/Conversations' }, /host must be one of/);
});

test('never touches a phone number: no repoint, no purchase, no release, no shopping', () => {
  refused({ host: 'api', method: 'POST', path: `2010-04-01/Accounts/${AC}/IncomingPhoneNumbers/${PN}.json`, body: { VoiceUrl: 'https://webhooks.twilio.com/x' } }, /never changes a phone number/);
  refused({ host: 'api', method: 'POST', path: `2010-04-01/Accounts/${AC}/IncomingPhoneNumbers.json`, body: { PhoneNumber: '+15555550100' } }, /never changes a phone number/);
  refused({ host: 'api', method: 'POST', path: `2010-04-01/Accounts/${AC}/IncomingPhoneNumbers/Local.json` }, /never changes a phone number/);
  refused({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${AC}/AvailablePhoneNumbers/US/Local.json` }, /never buys numbers/);
  allowed({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${AC}/IncomingPhoneNumbers.json` });
  allowed({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${AC}/IncomingPhoneNumbers/${PN}.json` });
});

test('TaskRouter live work and agent state are out of scope', () => {
  refused({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}/Tasks`, body: { Attributes: '{}' } }, /live work routing/);
  refused({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}/Workers/WK${'0'.repeat(32)}`, body: { ActivitySid: 'x' } }, /Agents manage their own state/);
  refused({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}/Workers`, body: { FriendlyName: 'x' } }, /worker writes/);
  refused({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}`, body: { FriendlyName: 'rename' } }, /not on the raw tool's allowlist/);
});

test('credentials are out of scope', () => {
  refused({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${AC}/Keys.json` }, /credentials/);
  refused({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${AC}/SigningKeys.json` }, /credentials/);
});

test('api.twilio.com is bound to the configured account', () => {
  refused({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${OTHER}.json` }, /bound to its configured account/);
  refused({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${OTHER}/IncomingPhoneNumbers.json` }, /bound to its configured account/);
  refused({ host: 'api', method: 'GET', path: '2010-04-01/Accounts.json' }, /bound to its configured account/);
  assert.equal(checkRawCall({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${AC}.json` }, {}).ok, false, 'no account configured = fail closed');
  allowed({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${AC}.json` });
  allowed({ host: 'api', method: 'GET', path: `/2010-04-01/Accounts/${AC}/Applications.json` });
});

test('reads outside the allowlist are refused (PII and call content)', () => {
  refused({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${AC}/Recordings.json` }, /allowlist/);
  refused({ host: 'api', method: 'GET', path: `2010-04-01/Accounts/${AC}/Transcriptions.json` }, /allowlist/);
  refused({ host: 'taskrouter', method: 'GET', path: `v1/Workspaces/${WS}/Tasks` }, /allowlist/);
});

test('query: identifier keys, no case-variant duplicates, scalars only', () => {
  const r = allowed({ host: 'studio', method: 'GET', path: 'v2/Flows', query: { PageSize: 20, Page: 0, Empty: '' } });
  assert.deepEqual(r.query, { PageSize: '20', Page: '0' });
  refused({ host: 'studio', method: 'GET', path: 'v2/Flows', query: { 'Page Size': 1 } }, /plain identifiers/);
  refused({ host: 'studio', method: 'GET', path: 'v2/Flows', query: { 'x[]': 1 } }, /plain identifiers/);
  refused({ host: 'studio', method: 'GET', path: 'v2/Flows', query: { PageSize: 1, pagesize: 2 } }, /duplicate/);
  refused({ host: 'studio', method: 'GET', path: 'v2/Flows', query: { PageSize: [1, 2] } }, /single scalar/);
  refused({ host: 'studio', method: 'GET', path: 'v2/Flows', query: 'PageSize=1' }, /object/);
});

test('body: form params only, no case duplicates, no webhook egress, JSON only where Twilio expects it', () => {
  refused({ host: 'studio', method: 'GET', path: 'v2/Flows', body: { x: 1 } }, /GET calls take no body/);
  refused({ host: 'taskrouter', method: 'POST', path: 'v1/Workspaces', body: [{ FriendlyName: 'x' }] }, /single object/);
  refused({ host: 'taskrouter', method: 'POST', path: 'v1/Workspaces', body: { FriendlyName: 'a', friendlyname: 'b' } }, /different casing/);
  refused({ host: 'taskrouter', method: 'POST', path: 'v1/Workspaces', body: { FriendlyName: 'MCP_Test_x', EventCallbackUrl: 'https://evil.example/hook' } }, /webhook egress/);
  refused({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}/Workflows`, body: { FriendlyName: 'w', AssignmentCallbackUrl: 'https://evil.example' } }, /webhook egress/);
  refused({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}/Workflows/${WW}`, body: { FallbackAssignmentCallbackUrl: 'https://evil.example' } }, /webhook egress/);
  refused({ host: 'taskrouter', method: 'POST', path: 'v1/Workspaces', body: { FriendlyName: { a: 1 } } }, /must be a scalar/);
  refused({ host: 'taskrouter', method: 'POST', path: 'v1/Workspaces', body: { 'Friendly Name': 'x' } }, /plain identifier/);
  const r = allowed({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}/Workflows`, body: { FriendlyName: 'w', Configuration: { task_routing: { filters: [] } }, TaskReservationTimeout: 60 } });
  assert.equal(r.form.Configuration, '{"task_routing":{"filters":[]}}');
  assert.equal(r.form.TaskReservationTimeout, '60');
});

test('Studio writes: create draft or published; updates only as draft; the IVR widget vocabulary only', () => {
  allowed({ host: 'studio', method: 'POST', path: 'v2/Flows', body: { FriendlyName: 'MCP_Test_x', Status: 'draft', Definition: minimalDef } });
  allowed({ host: 'studio', method: 'POST', path: 'v2/Flows', body: { FriendlyName: 'MCP_Test_x', Status: 'published', Definition: minimalDef } });
  refused({ host: 'studio', method: 'POST', path: 'v2/Flows', body: { FriendlyName: 'x', Definition: minimalDef } }, /Status "draft" or "published"/);
  refused({ host: 'studio', method: 'POST', path: 'v2/Flows', body: { FriendlyName: 'x', Status: 'draft' } }, /needs a Definition/);
  allowed({ host: 'studio', method: 'POST', path: `v2/Flows/${FW}`, body: { Status: 'draft', Definition: minimalDef } });
  refused({ host: 'studio', method: 'POST', path: `v2/Flows/${FW}`, body: { Status: 'published' } }, /only with Status "draft"/);
  refused({ host: 'studio', method: 'POST', path: `v2/Flows/${FW}`, body: { CommitMessage: 'x' } }, /only with Status "draft"/);
  refused({ host: 'studio', method: 'POST', path: `v2/Flows/${FW}`, body: { status: 'draft', Status: 'published' } }, /different casing/);
  const dial = { states: [{ name: 'Trigger', type: 'trigger', properties: {}, transitions: [] }, { name: 'out', type: 'make-outgoing-call-v2', properties: { to: '+15555550100' }, transitions: [] }] };
  refused({ host: 'studio', method: 'POST', path: 'v2/Flows', body: { FriendlyName: 'x', Status: 'draft', Definition: dial } }, /make-outgoing-call-v2/);
  const sms = { states: [{ name: 'm', type: 'send-message', properties: {}, transitions: [] }] };
  refused({ host: 'studio', method: 'POST', path: `v2/Flows/${FW}`, body: { Status: 'draft', Definition: JSON.stringify(sms) } }, /send-message/);
  const hold = { states: [{ name: 'q', type: 'enqueue-call', properties: { workflow_sid: WW, wait_url: 'https://evil.example/hold' }, transitions: [] }] };
  refused({ host: 'studio', method: 'POST', path: 'v2/Flows', body: { FriendlyName: 'x', Status: 'draft', Definition: hold } }, /wait_url/);
  refused({ host: 'studio', method: 'POST', path: 'v2/Flows', body: { FriendlyName: 'x', Status: 'draft', Definition: '{not json' } }, /not valid JSON/);
  // Validate stores nothing: any definition may be checked.
  allowed({ host: 'studio', method: 'POST', path: 'v2/Flows/Validate', body: { FriendlyName: 'x', Status: 'draft', Definition: dial } });
});

test('TaskRouter build writes are allowed', () => {
  allowed({ host: 'taskrouter', method: 'POST', path: 'v1/Workspaces', body: { FriendlyName: 'MCP_Test_ws' } });
  allowed({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}/Activities`, body: { FriendlyName: 'Break', Available: false } });
  allowed({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}/TaskQueues`, body: { FriendlyName: 'Sales', TargetWorkers: "skills HAS 'Sales'" } });
  allowed({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}/TaskQueues/${WQ}`, body: { MaxReservedWorkers: 2 } });
  allowed({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}/Workflows/${WW}`, body: { TaskReservationTimeout: 60 } });
});

test('SID placeholders are strict: wrong prefix or length never matches a template', () => {
  refused({ host: 'studio', method: 'GET', path: `v2/Flows/${WS}` }, /allowlist/);
  refused({ host: 'studio', method: 'GET', path: 'v2/Flows/FW123' }, /allowlist/);
  refused({ host: 'taskrouter', method: 'POST', path: `v1/Workspaces/${WS}/TaskQueues/${WQ}x` }, /allowlist/);
});

test('client write gate (used on EVERY non-GET, typed tools included)', () => {
  assert.ok(isAllowedWrite('studio', 'POST', 'v2/Flows'));
  assert.ok(isAllowedWrite('studio', 'POST', 'v2/Flows/Validate'));
  assert.ok(isAllowedWrite('taskrouter', 'POST', `v1/Workspaces/${WS}/Workflows`));
  assert.ok(!isAllowedWrite('studio', 'POST', `v2/Flows/${FW}/Executions`));
  assert.ok(!isAllowedWrite('api', 'POST', `2010-04-01/Accounts/${AC}/Calls.json`));
  assert.ok(!isAllowedWrite('api', 'POST', `2010-04-01/Accounts/${AC}/Messages.json`));
  assert.ok(!isAllowedWrite('api', 'POST', `2010-04-01/Accounts/${AC}/IncomingPhoneNumbers/${PN}.json`));
  assert.ok(!isAllowedWrite('taskrouter', 'POST', `v1/Workspaces/${WS}/Tasks`));
  assert.ok(!isAllowedWrite('studio', 'DELETE', `v2/Flows/${FW}`));
  assert.ok(!isAllowedWrite('studio', 'PUT', 'v2/Flows'));
});

test('definition rails flag every non-IVR widget and URL property', () => {
  assert.deepEqual(definitionProblems(minimalDef), []);
  assert.equal(definitionProblems({ states: [{ name: 'f', type: 'run-function', properties: { url: 'x' } }] }).length, 2);
  assert.equal(definitionProblems({ states: [{ name: 'v', type: 'record-voicemail', properties: { recording_status_callback_url: 'x' } }] }).length, 1);
  assert.ok(definitionProblems({}).length);
});

test('secrets are redacted, everything else passes through', () => {
  const r = redactSecrets({ sid: AC, auth_token: 'abc', nested: [{ secret: 's', api_key: 'k', Password: 'p', friendly_name: 'ok' }], empty_token: '' });
  assert.equal(r.auth_token, '[redacted]');
  assert.equal(r.nested[0].secret, '[redacted]');
  assert.equal(r.nested[0].api_key, '[redacted]');
  assert.equal(r.nested[0].Password, '[redacted]');
  assert.equal(r.nested[0].friendly_name, 'ok');
  assert.equal(r.sid, AC);
});

test('validateArgs enforces the advisory MCP schemas', () => {
  const schema = { type: 'object', properties: { name: { type: 'string' }, n: { type: 'integer', minimum: 1 }, t: { type: 'string', enum: ['A'] } }, required: ['name'], additionalProperties: false };
  assert.deepEqual(validateArgs(schema, { name: 'x', n: 2, t: 'A' }), []);
  const e = validateArgs(schema, { n: 0, t: 'B', extra: 1 });
  assert.ok(e.some((x) => x.includes('name is required')));
  assert.ok(e.some((x) => x.includes('>= 1')));
  assert.ok(e.some((x) => x.includes('one of')));
  assert.ok(e.some((x) => x.includes('not a known argument')));
});
