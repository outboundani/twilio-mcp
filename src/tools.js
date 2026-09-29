// MCP tool definitions + dispatch. Each tool maps to one or a few Twilio
// REST calls and returns plain JSON for the model.
//
// Scope is deliberate: contact center config reads + build actions (TaskRouter
// workspaces, queues, workflows; Studio IVR flows composed from the shared
// spec). The rails are code, not prompts:
//   - no deletes anywhere (the client refuses DELETE),
//   - nothing dials and nothing is sent (no Calls, Messages, Conversations,
//     no Studio Executions - POSTing one places a real outbound call),
//   - phone numbers are read-only: never bought, released, or repointed.
//     Pointing a number at a flow is the go-live moment, and a human does it.
// Every write passes the allowlist in src/rules.js at the HTTP client level,
// and the raw tool normalizes before it allowlists on top of that.

import { TwilioClient, TwilioError } from './twilio.js';
import { ABOUT } from './about.js';
import { checkRawCall, redactSecrets, validateArgs, isSid } from './rules.js';
import {
  validateSpec, normalizeSpec, specToFlow, flowToSpec, specToMermaid, definitionToMermaid,
  specQueues, QUEUE_ATTR, NORMALIZATIONS, HOURS_GAP,
} from './ivr.js';

// ---------- shared helpers ----------

const NAME_RE = /^[A-Za-z0-9 _.-]{1,64}$/;
const lc = (s) => String(s ?? '').toLowerCase();
const parseJson = (s, fallback = {}) => { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? fallback); } catch { return fallback; } };

function pick(list, ref, { sidPrefix, what, nameKey = 'friendly_name', hint }) {
  if (ref === undefined || ref === null || ref === '') {
    if (list.length === 1) return list[0];
    if (!list.length) throw new TwilioError(`No ${what} exists yet.${hint ? ` ${hint}` : ''}`, 404);
    throw new TwilioError(`There are ${list.length} ${what}s - say which one: ${list.map((x) => `${x[nameKey]} (${x.sid})`).join(', ')}.`, 409);
  }
  if (isSid(ref, sidPrefix)) {
    const hit = list.find((x) => x.sid === ref);
    if (!hit) throw new TwilioError(`No ${what} with SID ${ref}.`, 404);
    return hit;
  }
  const exact = list.filter((x) => lc(x[nameKey]) === lc(ref));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new TwilioError(`Ambiguous ${what} "${ref}" - use the SID: ${exact.map((x) => x.sid).join(', ')}.`, 409);
  const wide = list.filter((x) => lc(x[nameKey]).includes(lc(ref)));
  if (wide.length === 1) return wide[0];
  if (wide.length > 1) throw new TwilioError(`Ambiguous ${what} "${ref}" - matches: ${wide.map((x) => x[nameKey]).join(', ')}.`, 409);
  throw new TwilioError(`No ${what} found matching "${ref}".`, 404);
}

const listWorkspaces = async (tw) => (await tw.listAll('taskrouter', 'v1/Workspaces', 'workspaces')).entities;
const listQueues = async (tw, ws) => (await tw.listAll('taskrouter', `v1/Workspaces/${ws}/TaskQueues`, 'task_queues')).entities;
const listWorkflows = async (tw, ws) => (await tw.listAll('taskrouter', `v1/Workspaces/${ws}/Workflows`, 'workflows')).entities;
const listActivities = async (tw, ws) => (await tw.listAll('taskrouter', `v1/Workspaces/${ws}/Activities`, 'activities')).entities;
const listWorkers = async (tw, ws) => (await tw.listAll('taskrouter', `v1/Workspaces/${ws}/Workers`, 'workers')).entities;
const listFlows = async (tw) => (await tw.listAll('studio', 'v2/Flows', 'flows')).entities;
const listNumbers = async (tw) => (await tw.listAll('api', tw.acct('/IncomingPhoneNumbers.json'), 'incoming_phone_numbers')).entities;

async function resolveWorkspace(tw, ref) {
  return pick(await listWorkspaces(tw), ref, { sidPrefix: 'WS', what: 'workspace', hint: 'Create one with create_workspace.' });
}

async function resolveFlow(tw, ref) {
  if (isSid(ref, 'FW')) return tw.get('studio', `v2/Flows/${ref}`);
  const hit = pick(await listFlows(tw), ref, { sidPrefix: 'FW', what: 'flow' });
  return tw.get('studio', `v2/Flows/${hit.sid}`);
}

// A Studio flow is live on a number when the number's voice (or SMS) URL is
// the flow's webhook: https://webhooks.twilio.com/v1/Accounts/AC.../Flows/FW...
export function flowSidFromUrl(url) {
  const m = String(url ?? '').match(/^https:\/\/webhooks\.twilio\.com\/v1\/Accounts\/AC[0-9a-fA-F]{32}\/Flows\/(FW[0-9a-fA-F]{32})(?:[/?].*)?$/);
  return m ? m[1] : null;
}

function describeTarget(url, appSid, trunkSid, flowNames) {
  if (trunkSid) return { kind: 'sip_trunk', trunk_sid: trunkSid };
  if (appSid) return { kind: 'twiml_app', application_sid: appSid };
  const fw = flowSidFromUrl(url);
  if (fw) return { kind: 'studio_flow', flow_sid: fw, flow: flowNames[fw] || '(unknown flow)' };
  if (url) return { kind: 'webhook', url };
  return { kind: 'none' };
}

function numbersPointingAt(numbers, flowSid) {
  return numbers.filter((n) => flowSidFromUrl(n.voice_url) === flowSid || flowSidFromUrl(n.sms_url) === flowSid).map((n) => n.phone_number);
}

// Workflow routing, summarized: filter -> expression -> target queue names.
function summarizeWorkflow(wf, queueNames) {
  const cfg = parseJson(wf.configuration);
  const tr = cfg.task_routing || {};
  return {
    sid: wf.sid,
    name: wf.friendly_name,
    routes: (tr.filters || []).map((f) => ({
      filter: f.filter_friendly_name,
      expression: f.expression,
      queues: (f.targets || []).map((t) => queueNames[t.queue] || t.queue),
    })),
    default_queue: tr.default_filter?.queue ? (queueNames[tr.default_filter.queue] || tr.default_filter.queue) : null,
    task_reservation_timeout: wf.task_reservation_timeout,
  };
}

const routeExpression = (queue) => `${QUEUE_ATTR} == '${queue}'`;
const normExpr = (e) => String(e ?? '').replace(/\s+/g, ' ').replace(/"/g, '\'').trim();

// Which of the spec's queues does this workflow NOT route? (Studio's
// Validate endpoint never checks workflow_sid or task attributes, so this
// check is ours.)
function unroutedQueues(wf, queues, queueNames) {
  const filters = parseJson(wf.configuration).task_routing?.filters || [];
  return queues.filter((q) => !filters.some((f) => normExpr(f.expression) === routeExpression(q)
    && (f.targets || []).some((t) => queueNames[t.queue])));
}

// Twilio seeds every new workspace with Offline, Idle (the available one),
// Busy, and Reserved (verified live). The defaults here only fill the gaps a
// contact center needs on day one; an existing available activity (Idle)
// satisfies "Available", so there are never two ready states.
const DEFAULT_ACTIVITIES = [
  { name: 'Available', available: true },
  { name: 'Offline', available: false },
  { name: 'Unavailable', available: false },
  { name: 'Break', available: false },
];

const GO_LIVE = 'Nothing is live: no phone number points at this flow. Going live means setting a number\'s "A call comes in" to this Studio flow (its voice URL becomes the webhook_url). That is a human\'s job in the Twilio Console, and this server will never do it.';

// Landmine (verified live, error 20001 "Activity Sids cannot be empty"): in
// a single-tasking workspace every queue needs a ReservationActivitySid and
// an AssignmentActivitySid, although the docs list both as optional. They
// map to Twilio's seeded Reserved and Busy activities. Multitasking
// workspaces do not take them.
async function createQueue(tw, ws, { name, target_workers, max_reserved_workers, task_order }) {
  const form = {
    FriendlyName: name,
    TargetWorkers: target_workers || `skills HAS '${name}'`,
    MaxReservedWorkers: max_reserved_workers,
    TaskOrder: task_order,
  };
  const workspace = await tw.get('taskrouter', `v1/Workspaces/${ws}`);
  if (!workspace.multi_task_enabled) {
    const acts = await listActivities(tw, ws);
    const find = (n) => acts.find((x) => lc(x.friendly_name) === n);
    const reserved = find('reserved');
    const busy = find('busy');
    if (!reserved || !busy) {
      throw new TwilioError(`Workspace "${workspace.friendly_name}" is single-tasking, so Twilio requires every queue to name a reservation and an assignment activity, and this workspace has no "Reserved" and "Busy" activities to use. Add them (twilio_api_call POST v1/Workspaces/${ws}/Activities), then retry.`, 409);
    }
    form.ReservationActivitySid = reserved.sid;
    form.AssignmentActivitySid = busy.sid;
  }
  return tw.post('taskrouter', `v1/Workspaces/${ws}/TaskQueues`, form);
}

// ---------- tools ----------

const SPEC_DOC = 'The shared IVR spec: { name, language? (en-US), greeting?, hours? (NOT native on Studio: reported as a gap, callers always reach the menu), menu: { prompt, options: [{ digit (0-9,*,#), label?, action }], no_input?: { retries (0-5, default 2), message?, then (an action, default hangup) } } }. Actions: { type: "transfer_to_queue", queue, message? } | { type: "submenu", menu } (max 3 menu levels) | { type: "previous_menu" } (submenus only) | { type: "play_message", message, then? } (no then = back to this menu) | { type: "voicemail", message? } | { type: "hangup" }.';

export const TOOLS = [
  {
    name: 'about',
    description: 'Who operates this server, why it exists, the ground rules, the IVR build playbook, and the verified Twilio API landmine list. Call this when you need context about the operator or how to behave.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    twilio: false,
    handler: () => ABOUT,
  },
  {
    name: 'check_connection',
    description: 'Verify the Worker can authenticate to Twilio with its API key. Returns the account name, SID, status, type (Trial or Full), and counts of Studio flows, TaskRouter workspaces, and phone numbers. Run this first if other tools are failing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (tw) => {
      const [acct, flows, workspaces, numbers] = await Promise.all([
        tw.get('api', tw.acct('.json')), listFlows(tw), listWorkspaces(tw), listNumbers(tw),
      ]);
      return {
        ok: true, account: acct.friendly_name, account_sid: acct.sid, status: acct.status, type: acct.type,
        counts: { studio_flows: flows.length, taskrouter_workspaces: workspaces.length, phone_numbers: numbers.length },
      };
    },
  },
  {
    name: 'contact_center_overview',
    description: 'One-shot map of the whole Twilio contact center: every TaskRouter workspace (activities, queues and their target-worker expressions, workflows and what each route sends where, worker count), every Studio flow (status, which workflow and queue each Enqueue widget targets, which numbers point at it), every phone number and what its voice URL runs, plus wiring checks (flows that enqueue into a missing workflow, queues no workflow routes to, what is and is not live). Run this before building so you reuse what exists.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (tw) => {
      const [workspaces, flowList, numbers] = await Promise.all([listWorkspaces(tw), listFlows(tw), listNumbers(tw)]);
      const checks = [];
      const workflowNames = {};
      const wsOut = [];
      for (const ws of workspaces) {
        const [queues, workflows, activities, workers] = await Promise.all([
          listQueues(tw, ws.sid), listWorkflows(tw, ws.sid), listActivities(tw, ws.sid), listWorkers(tw, ws.sid),
        ]);
        const queueNames = Object.fromEntries(queues.map((q) => [q.sid, q.friendly_name]));
        const wfs = workflows.map((w) => summarizeWorkflow(w, queueNames));
        for (const w of wfs) workflowNames[w.sid] = `${w.name} (${ws.friendly_name})`;
        const routed = new Set(wfs.flatMap((w) => [...w.routes.flatMap((r) => r.queues), w.default_queue]).filter(Boolean));
        for (const q of queues) if (!routed.has(q.friendly_name)) checks.push(`Queue "${q.friendly_name}" in workspace "${ws.friendly_name}" is not targeted by any workflow.`);
        if (!workers.length) checks.push(`Workspace "${ws.friendly_name}" has no workers yet: enqueued calls would wait for an agent.`);
        wsOut.push({
          sid: ws.sid, name: ws.friendly_name,
          activities: activities.map((a) => `${a.friendly_name}${a.available ? ' (available)' : ''}`),
          queues: queues.map((q) => ({ sid: q.sid, name: q.friendly_name, target_workers: q.target_workers })),
          workflows: wfs,
          workers: workers.length,
        });
      }
      const flowNames = Object.fromEntries(flowList.map((f) => [f.sid, f.friendly_name]));
      const flows = [];
      for (const f of flowList) {
        const full = await tw.get('studio', `v2/Flows/${f.sid}`);
        const enq = (full.definition?.states || []).filter((s) => s.type === 'enqueue-call').map((s) => {
          const wf = s.properties?.workflow_sid;
          if (wf && !workflowNames[wf]) checks.push(`Flow "${f.friendly_name}" widget "${s.name}" enqueues into workflow ${wf}, which is not in any workspace on this account.`);
          return { widget: s.name, workflow: wf ? (workflowNames[wf] || wf) : null, queue: parseJson(s.properties?.task_attributes)[QUEUE_ATTR] || s.properties?.queue_name || null };
        });
        const pointing = numbersPointingAt(numbers, f.sid);
        flows.push({ sid: f.sid, name: f.friendly_name, status: f.status, revision: f.revision, enqueues: enq, live_on_numbers: pointing });
      }
      const nums = numbers.map((n) => ({
        number: n.phone_number, name: n.friendly_name,
        voice: describeTarget(n.voice_url, n.voice_application_sid, n.trunk_sid, flowNames),
      }));
      if (!numbers.length) checks.push('This account has no phone numbers, so nothing here is reachable by callers. (Buying and pointing numbers is a human\'s job.)');
      else if (!flows.some((f) => f.live_on_numbers.length)) checks.push('No phone number points at any Studio flow: every flow here is built but not live.');
      return { workspaces: wsOut, flows, phone_numbers: nums, checks };
    },
  },

  // ----- numbers (read only) -----
  {
    name: 'list_phone_numbers',
    description: 'List the account\'s phone numbers and what each one runs when a call comes in: a Studio flow (by name), a TwiML app, a SIP trunk, a raw webhook, or nothing. READ ONLY by design: this server never buys, releases, or repoints numbers. Pointing a number at a flow is the go-live moment and a human does it in the Twilio Console.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (tw) => {
      const [numbers, flows] = await Promise.all([listNumbers(tw), listFlows(tw)]);
      const flowNames = Object.fromEntries(flows.map((f) => [f.sid, f.friendly_name]));
      return {
        total: numbers.length,
        numbers: numbers.map((n) => ({
          sid: n.sid, number: n.phone_number, name: n.friendly_name,
          voice: describeTarget(n.voice_url, n.voice_application_sid, n.trunk_sid, flowNames),
          sms: describeTarget(n.sms_url, n.sms_application_sid, null, flowNames),
          capabilities: n.capabilities,
        })),
        note: numbers.length ? undefined : 'No phone numbers on this account. Buying one is a human decision in the Twilio Console.',
      };
    },
  },

  // ----- TaskRouter -----
  {
    name: 'list_workspaces',
    description: 'List TaskRouter workspaces (the container for queues, workflows, activities, and workers). In Twilio, a workspace is the contact center\'s routing brain.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (tw) => {
      const ws = await listWorkspaces(tw);
      return {
        total: ws.length,
        workspaces: ws.map((w) => ({
          sid: w.sid, name: w.friendly_name, default_activity: w.default_activity_name, timeout_activity: w.timeout_activity_name,
          multi_task_enabled: w.multi_task_enabled, prioritize_queue_order: w.prioritize_queue_order, created: w.date_created,
        })),
      };
    },
  },
  {
    name: 'list_task_queues',
    description: 'List the task queues in a workspace, with each queue\'s target-workers expression (which agents it can reach), task order, and max reserved workers.',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string', description: 'Workspace name or SID (optional when there is exactly one)' } },
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      const ws = await resolveWorkspace(tw, a.workspace);
      const qs = await listQueues(tw, ws.sid);
      return {
        workspace: ws.friendly_name, total: qs.length,
        task_queues: qs.map((q) => ({ sid: q.sid, name: q.friendly_name, target_workers: q.target_workers, task_order: q.task_order, max_reserved_workers: q.max_reserved_workers })),
      };
    },
  },
  {
    name: 'list_workflows',
    description: 'List the workflows in a workspace, decoded: each route\'s filter expression and the queue(s) it targets, plus the default queue. Workflows are how an IVR\'s Enqueue widget lands a call in the right queue.',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string', description: 'Workspace name or SID (optional when there is exactly one)' } },
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      const ws = await resolveWorkspace(tw, a.workspace);
      const [wfs, qs] = await Promise.all([listWorkflows(tw, ws.sid), listQueues(tw, ws.sid)]);
      const queueNames = Object.fromEntries(qs.map((q) => [q.sid, q.friendly_name]));
      return { workspace: ws.friendly_name, total: wfs.length, workflows: wfs.map((w) => summarizeWorkflow(w, queueNames)) };
    },
  },
  {
    name: 'list_activities',
    description: 'List the activities (agent states such as Available, Offline, Break) in a workspace, and which ones count as available for work.',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string', description: 'Workspace name or SID (optional when there is exactly one)' } },
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      const ws = await resolveWorkspace(tw, a.workspace);
      const acts = await listActivities(tw, ws.sid);
      return { workspace: ws.friendly_name, total: acts.length, activities: acts.map((x) => ({ sid: x.sid, name: x.friendly_name, available: x.available })) };
    },
  },
  {
    name: 'list_workers',
    description: 'List the workers (agents) in a workspace with their current activity, availability, and attributes (skills and so on, which queue target expressions match against). Read only: this server never changes an agent\'s state.',
    inputSchema: {
      type: 'object',
      properties: { workspace: { type: 'string', description: 'Workspace name or SID (optional when there is exactly one)' } },
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      const ws = await resolveWorkspace(tw, a.workspace);
      const ws2 = await listWorkers(tw, ws.sid);
      return {
        workspace: ws.friendly_name, total: ws2.length,
        workers: ws2.map((w) => ({ sid: w.sid, name: w.friendly_name, activity: w.activity_name, available: w.available, attributes: parseJson(w.attributes) })),
      };
    },
  },
  {
    name: 'create_workspace',
    description: 'Create a TaskRouter workspace with a sensible set of agent activities. Twilio seeds Offline, Idle (the available state), Busy, and Reserved; this tool adds Unavailable and Break (and Available only if no available state exists), never duplicating. Single-tasking (one call per agent) by default. No event callback URL is set. Refuses a name that already exists. Next steps: create_task_queue for each queue, then create_workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workspace name, e.g. "Acme Contact Center"' },
        activities: {
          type: 'array', description: 'Override the default activities',
          items: { type: 'object', properties: { name: { type: 'string' }, available: { type: 'boolean' } }, required: ['name', 'available'], additionalProperties: false },
        },
        multi_task_enabled: { type: 'boolean', description: 'Enable multitasking (voice plus digital channels per agent). Default false.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      if (!NAME_RE.test(a.name)) throw new TwilioError('Workspace names may use letters, digits, space, _, ., - (64 max).', 400);
      const existing = await listWorkspaces(tw);
      if (existing.some((w) => lc(w.friendly_name) === lc(a.name))) throw new TwilioError(`A workspace named "${a.name}" already exists. This server creates, it does not overwrite: pick a new name.`, 409);
      const ws = await tw.post('taskrouter', 'v1/Workspaces', { FriendlyName: a.name, MultiTaskEnabled: a.multi_task_enabled ?? false });
      const have = await listActivities(tw, ws.sid);
      const wanted = a.activities?.length ? a.activities : DEFAULT_ACTIVITIES;
      const created = [];
      for (const act of wanted) {
        if (have.some((h) => lc(h.friendly_name) === lc(act.name))) continue;
        if (!a.activities?.length && act.available && have.some((h) => h.available)) continue;
        const r = await tw.post('taskrouter', `v1/Workspaces/${ws.sid}/Activities`, { FriendlyName: act.name, Available: act.available });
        created.push(r.friendly_name);
      }
      const acts = await listActivities(tw, ws.sid);
      return {
        created: true, sid: ws.sid, name: ws.friendly_name,
        activities: acts.map((x) => `${x.friendly_name}${x.available ? ' (available)' : ''}`),
        seeded_by_twilio: have.map((h) => `${h.friendly_name}${h.available ? ' (available)' : ''}`),
        added_by_this_tool: created,
        queue_activities: 'Queues in this (single-tasking) workspace reserve agents into "Reserved" and assign them into "Busy" (Twilio requires both).',
        next: 'create_task_queue for each queue, then create_workflow to route to them.',
      };
    },
  },
  {
    name: 'create_task_queue',
    description: 'Create a task queue in a workspace. By default the queue targets workers whose attributes list the queue name as a skill (target_workers: skills HAS \'<name>\'); pass target_workers to override (e.g. "1==1" for everyone). Refuses a name that already exists in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name or SID (optional when there is exactly one)' },
        name: { type: 'string', description: 'Queue name, e.g. "Sales" (letters, digits, space, _, ., -)' },
        target_workers: { type: 'string', description: 'TaskRouter target-workers expression. Default: skills HAS \'<name>\'' },
        max_reserved_workers: { type: 'integer', minimum: 1, maximum: 50 },
        task_order: { type: 'string', enum: ['FIFO', 'LIFO'] },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      if (!NAME_RE.test(a.name)) throw new TwilioError('Queue names may use letters, digits, space, _, ., - (64 max).', 400);
      const ws = await resolveWorkspace(tw, a.workspace);
      const qs = await listQueues(tw, ws.sid);
      if (qs.some((q) => lc(q.friendly_name) === lc(a.name))) throw new TwilioError(`Queue "${a.name}" already exists in "${ws.friendly_name}".`, 409);
      const q = await createQueue(tw, ws.sid, a);
      return { created: true, workspace: ws.friendly_name, sid: q.sid, name: q.friendly_name, target_workers: q.target_workers, task_order: q.task_order };
    },
  },
  {
    name: 'create_workflow',
    description: `Create a TaskRouter workflow that routes each call to its queue by the task attribute ${QUEUE_ATTR} (the attribute build_ivr's Enqueue widgets set): one route per queue, expression ${QUEUE_ATTR} == '<queue>'. Give the queue names directly, or pass an IVR spec and the queues are read from its transfer_to_queue actions. Missing queues are an error unless create_missing_queues is true (then they are created with the create_task_queue defaults). Twilio itself validates that every targeted queue exists. Refuses a name that already exists in the workspace.`,
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name or SID (optional when there is exactly one)' },
        name: { type: 'string', description: 'Workflow name, e.g. "Main Line Routing"' },
        queues: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Queue names to route to' },
        spec: { type: 'object', description: 'An IVR spec: route to every queue its transfer_to_queue actions name' },
        default_queue: { type: 'string', description: 'Queue for tasks that match no route (default: the first queue)' },
        create_missing_queues: { type: 'boolean', description: 'Create queues that do not exist yet (default false)' },
        task_reservation_timeout: { type: 'integer', minimum: 1, maximum: 86400, description: 'Seconds an agent has to accept a reservation (Twilio default 120)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      if (!NAME_RE.test(a.name)) throw new TwilioError('Workflow names may use letters, digits, space, _, ., - (64 max).', 400);
      const names = a.queues?.length ? a.queues : (a.spec ? specQueues(a.spec) : []);
      if (!names.length) throw new TwilioError('Give queues (names) or an IVR spec with transfer_to_queue actions.', 400);
      const bad = names.filter((n) => !NAME_RE.test(n));
      if (bad.length) throw new TwilioError(`Queue names may use letters, digits, space, _, ., - only: ${bad.join(', ')}`, 400);
      const ws = await resolveWorkspace(tw, a.workspace);
      const wfs = await listWorkflows(tw, ws.sid);
      if (wfs.some((w) => lc(w.friendly_name) === lc(a.name))) throw new TwilioError(`Workflow "${a.name}" already exists in "${ws.friendly_name}".`, 409);
      let qs = await listQueues(tw, ws.sid);
      const missing = names.filter((n) => !qs.some((q) => q.friendly_name === n));
      const createdQueues = [];
      if (missing.length) {
        if (!a.create_missing_queues) throw new TwilioError(`These queues do not exist in "${ws.friendly_name}" yet: ${missing.join(', ')}. Create them with create_task_queue, or pass create_missing_queues: true.`, 404);
        for (const n of missing) createdQueues.push((await createQueue(tw, ws.sid, { name: n })).friendly_name);
        qs = await listQueues(tw, ws.sid);
      }
      const sidOf = (n) => qs.find((q) => q.friendly_name === n)?.sid;
      const def = a.default_queue || names[0];
      if (!sidOf(def)) throw new TwilioError(`default_queue "${def}" does not exist in "${ws.friendly_name}".`, 404);
      const configuration = {
        task_routing: {
          filters: names.map((n) => ({ filter_friendly_name: n, expression: routeExpression(n), targets: [{ queue: sidOf(n) }] })),
          default_filter: { queue: sidOf(def) },
        },
      };
      const wf = await tw.post('taskrouter', `v1/Workspaces/${ws.sid}/Workflows`, {
        FriendlyName: a.name, Configuration: JSON.stringify(configuration), TaskReservationTimeout: a.task_reservation_timeout,
      });
      const queueNames = Object.fromEntries(qs.map((q) => [q.sid, q.friendly_name]));
      return { created: true, workspace: ws.friendly_name, ...summarizeWorkflow(wf, queueNames), queues_created: createdQueues };
    },
  },

  // ----- Studio -----
  {
    name: 'list_flows',
    description: 'List Studio flows (the IVRs): name, SID, status (draft or published), revision, last update, and which phone numbers point at each one (if none, it is not live).',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Substring of the flow name' } },
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      const [flows, numbers] = await Promise.all([listFlows(tw), listNumbers(tw)]);
      const rows = a.search ? flows.filter((f) => lc(f.friendly_name).includes(lc(a.search))) : flows;
      return {
        total: rows.length,
        flows: rows.map((f) => ({ sid: f.sid, name: f.friendly_name, status: f.status, revision: f.revision, updated: f.date_updated, live_on_numbers: numbersPointingAt(numbers, f.sid) })),
      };
    },
  },
  {
    name: 'get_flow',
    description: 'Get one Studio flow by name or SID: status, revision, commit message, Twilio\'s own validity verdict and warnings, the webhook URL a number would point at to go live, the widget list, and (with include_definition) the full flow JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Flow name or SID (FW...)' },
        include_definition: { type: 'boolean', description: 'Include the full flow definition JSON (large)' },
      },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      const f = await resolveFlow(tw, a.flow);
      const numbers = await listNumbers(tw);
      return {
        sid: f.sid, name: f.friendly_name, status: f.status, revision: f.revision, commit_message: f.commit_message,
        valid: f.valid, errors: f.errors, warnings: f.warnings, webhook_url: f.webhook_url, updated: f.date_updated,
        live_on_numbers: numbersPointingAt(numbers, f.sid),
        widgets: (f.definition?.states || []).map((s) => ({ name: s.name, type: s.type })),
        definition: a.include_definition ? f.definition : undefined,
      };
    },
  },
  {
    name: 'render_flow',
    description: 'Draw an IVR as a Mermaid flowchart to show the user in chat. Pass a spec (to preview before build_ivr; no Twilio call needed) or an existing flow by name or SID (renders every widget and transition; as_spec: true renders the exported spec view instead). Always show the diagram and get ONE approval before building.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'IVR spec (see build_ivr)' },
        flow: { type: 'string', description: 'Existing flow name or SID' },
        as_spec: { type: 'boolean', description: 'For a flow: export it to the shared spec first and render that' },
      },
      additionalProperties: false,
    },
    twilio: 'optional',
    handler: async (tw, a) => {
      if (a.spec) {
        const v = validateSpec(a.spec);
        if (!v.ok) return { valid: false, errors: v.errors };
        return { valid: true, mermaid: specToMermaid(a.spec), gaps: v.gaps, note: 'Render this mermaid for the user and get one approval before build_ivr.' };
      }
      if (!a.flow) throw new TwilioError('Pass spec or flow.', 400);
      if (!tw) throw new TwilioError('Rendering an existing flow needs a connected Twilio account (open /setup).', 503);
      const f = await resolveFlow(tw, a.flow);
      if (a.as_spec) {
        const { spec, lossy } = flowToSpec(f.definition, { name: f.friendly_name });
        return { flow: f.friendly_name, mermaid: specToMermaid(spec), lossy };
      }
      return { flow: f.friendly_name, status: f.status, mermaid: definitionToMermaid(f.definition) };
    },
  },
  {
    name: 'build_ivr',
    description: `Compose a Studio IVR flow from the shared IVR spec, validate it with Twilio's own POST /v2/Flows/Validate (errors relayed verbatim), then create it as a DRAFT (publish: true publishes instead; harmless, because no phone number points at a new flow). ${SPEC_DOC} transfer_to_queue uses an Enqueue Call widget into a TaskRouter workflow with task attribute ${QUEUE_ATTR}; the workflow must already route every queue the spec names (create_workflow with the same spec does exactly that) - this is checked before anything is sent, because Twilio's Validate does not check it. dry_run: true composes and validates without creating. Flow names are identity: an existing name is refused unless replace_draft: true, which saves a new DRAFT revision (the published revision keeps serving untouched; publishing over an existing flow is refused if any number points at it). Returns the flow SID, the webhook URL, a Mermaid diagram, and any gaps. It never points a number at the flow: going live is a human's job.`,
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'The IVR spec' },
        workspace: { type: 'string', description: 'TaskRouter workspace name or SID (optional when there is exactly one)' },
        workflow: { type: 'string', description: 'Workflow name or SID the Enqueue widgets use (optional when the workspace has exactly one)' },
        publish: { type: 'boolean', description: 'Publish instead of saving as draft (default false)' },
        dry_run: { type: 'boolean', description: 'Compose and run Twilio Validate only; create nothing' },
        replace_draft: { type: 'boolean', description: 'If a flow with this name exists, save this as a new draft revision of it' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      const v = validateSpec(a.spec);
      if (!v.ok) return { valid: false, stage: 'spec', errors: v.errors };
      const queues = specQueues(normalizeSpec(a.spec));
      let workflow = null;
      if (queues.length) {
        const ws = await resolveWorkspace(tw, a.workspace);
        const [wfs, qs] = await Promise.all([listWorkflows(tw, ws.sid), listQueues(tw, ws.sid)]);
        const wf = pick(wfs, a.workflow, { sidPrefix: 'WW', what: 'workflow', hint: `Create one with create_workflow (pass this spec) in "${ws.friendly_name}".` });
        const queueNames = Object.fromEntries(qs.map((q) => [q.sid, q.friendly_name]));
        const unrouted = unroutedQueues(wf, queues, queueNames);
        if (unrouted.length) {
          return {
            valid: false, stage: 'routing',
            errors: unrouted.map((q) => `workflow "${wf.friendly_name}" has no route for ${routeExpression(q)} (queue "${q}")${qs.some((x) => x.friendly_name === q) ? '' : ' and the queue does not exist'}`),
            fix: 'Run create_workflow with this spec (and create_missing_queues: true if queues are missing), then build again with that workflow.',
          };
        }
        workflow = { sid: wf.sid, name: wf.friendly_name, workspace: ws.friendly_name };
      }
      const definition = specToFlow(a.spec, { workflowSid: workflow?.sid });
      const name = a.spec.name;
      const status = a.publish ? 'published' : 'draft';
      try {
        await tw.post('studio', 'v2/Flows/Validate', { FriendlyName: name, Status: status, Definition: JSON.stringify(definition) });
      } catch (e) {
        if (e instanceof TwilioError && e.details) return { valid: false, stage: 'twilio_validate', message: e.message, twilio_errors: e.details.errors, twilio_warnings: e.details.warnings };
        throw e;
      }
      const mermaid = specToMermaid(a.spec);
      const base = { valid: true, validated_by: 'POST https://studio.twilio.com/v2/Flows/Validate', gaps: v.gaps, workflow, widgets: definition.states.length, mermaid };
      if (a.dry_run) return { ...base, created: false, note: 'Dry run: composed and validated by Twilio, nothing created.' };

      const existing = (await listFlows(tw)).filter((f) => lc(f.friendly_name) === lc(name));
      let flow;
      if (existing.length) {
        if (!a.replace_draft) return { ...base, created: false, error: `A flow named "${name}" already exists (${existing.map((f) => f.sid).join(', ')}). Flow names are identity here: pick a new name, or pass replace_draft: true to save a new draft revision of it.` };
        if (existing.length > 1) return { ...base, created: false, error: `More than one flow is named "${name}"; update one by SID through the Twilio Console.` };
        const target = existing[0];
        if (a.publish) {
          const pointing = numbersPointingAt(await listNumbers(tw), target.sid);
          if (pointing.length) return { ...base, created: false, error: `Refused: ${pointing.join(', ')} point at "${name}", so publishing would change what live callers hear. Saved nothing. Build as a draft (omit publish), review it, and let a human publish in the Twilio Console.` };
        }
        flow = await tw.post('studio', `v2/Flows/${target.sid}`, { Status: status, Definition: JSON.stringify(definition), CommitMessage: 'Updated by twilio-mcp from the shared IVR spec' });
      } else {
        flow = await tw.post('studio', 'v2/Flows', { FriendlyName: name, Status: status, Definition: JSON.stringify(definition), CommitMessage: 'Composed by twilio-mcp from the shared IVR spec' });
      }
      return {
        ...base, created: !existing.length, updated: Boolean(existing.length),
        sid: flow.sid, name: flow.friendly_name, status: flow.status, revision: flow.revision,
        twilio_valid: flow.valid, twilio_warnings: flow.warnings,
        webhook_url: flow.webhook_url,
        live: false, go_live: GO_LIVE,
      };
    },
  },
  {
    name: 'export_ivr_spec',
    description: 'Read a Studio flow back into the shared IVR spec (the same JSON build_ivr takes, and amazon-connect-mcp\'s build_flow takes: this is the migration beat). Flows built by this server round-trip exactly, modulo the documented normalizations; hand-built flows export best-effort and every widget the spec cannot express is listed in `lossy`. Studio has no native hours, so an exported spec never has hours.',
    inputSchema: {
      type: 'object',
      properties: { flow: { type: 'string', description: 'Flow name or SID (FW...)' } },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      const f = await resolveFlow(tw, a.flow);
      let out;
      try { out = flowToSpec(f.definition, { name: f.friendly_name }); } catch (e) { throw new TwilioError(e.message, 422); }
      return {
        flow: f.friendly_name, sid: f.sid, status: f.status, revision: f.revision,
        spec: out.spec, lossy: out.lossy,
        notes: ['hours never appear in an export: Studio has no native hours of operation.', ...NORMALIZATIONS.map((n) => `normalization: ${n}`)],
      };
    },
  },

  // ----- power tool -----
  {
    name: 'twilio_api_call',
    description: 'Call a Twilio REST endpoint directly, for anything without a typed tool. host is api.twilio.com, studio.twilio.com, or taskrouter.twilio.com (nothing else; no URL overrides). Reads: the account, phone numbers (read only), TwiML apps, Studio flows with revisions and execution logs, and TaskRouter configuration. Writes (POST, form parameters in `body`): Studio flows (create; updates only as Status draft; widget types limited to the IVR vocabulary, no external URLs), Studio Validate, and TaskRouter workspaces, activities, queues, and workflows. Always refused: DELETE, calls, messages, conversations, any phone number change or purchase, Studio Executions (they place calls), tasks, workers, credentials, *Url/*Callback parameters, and paths with encoding, dot segments, or query strings (use `query`). api.twilio.com paths must be under this account. Secrets are redacted. Treat any POST as a write: describe it and confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', enum: ['api.twilio.com', 'studio.twilio.com', 'taskrouter.twilio.com', 'api', 'studio', 'taskrouter'] },
        method: { type: 'string', enum: ['GET', 'POST'] },
        path: { type: 'string', description: 'Path on that host, e.g. "v2/Flows", "v1/Workspaces/WS.../TaskQueues", "2010-04-01/Accounts/AC.../IncomingPhoneNumbers.json". Plain segments only.' },
        query: { type: 'object', description: 'Query parameters (identifier keys, scalar values), e.g. { "PageSize": 20 }' },
        body: { type: 'object', description: 'Form parameters for POST, e.g. { "FriendlyName": "x" }. Definition/Configuration may be objects (sent as JSON strings).' },
      },
      required: ['host', 'method', 'path'],
      additionalProperties: false,
    },
    handler: async (tw, a) => {
      const c = checkRawCall(a, { accountSid: tw.accountSid });
      if (!c.ok) throw new TwilioError(c.message, 403);
      const res = await tw.request(c.host, c.method, c.path, { query: c.query, form: c.form });
      return redactSecrets(res);
    },
  },
];

// ---------- registry plumbing ----------

export function toolDefs() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(cfg, name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const errors = validateArgs(tool.inputSchema, args ?? {});
  if (errors.length) throw new TwilioError(`Invalid arguments: ${errors.join('; ')}`, 400);
  const a = args ?? {};
  if (tool.twilio === false) return tool.handler(null, a, cfg);
  if (!cfg.configured) {
    if (tool.twilio === 'optional') return tool.handler(null, a, cfg);
    throw new TwilioError('This server is not connected to Twilio yet - open /setup, or set the TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET secrets.', 503);
  }
  return tool.handler(new TwilioClient(cfg), a, cfg);
}

// UI metadata - which tools are writes, and how they group on the landing page.
export const WRITE_TOOLS = new Set(['create_workspace', 'create_task_queue', 'create_workflow', 'build_ivr', 'twilio_api_call']);

export const TOOL_GROUPS = [
  { name: 'Account & Overview', icon: '🔌', tools: ['about', 'check_connection', 'contact_center_overview'] },
  { name: 'Phone Numbers (read only)', icon: '📇', tools: ['list_phone_numbers'] },
  { name: 'TaskRouter (Queues & Routing)', icon: '🎯', tools: ['list_workspaces', 'list_task_queues', 'list_workflows', 'list_activities', 'list_workers', 'create_workspace', 'create_task_queue', 'create_workflow'] },
  { name: 'Studio (IVR Builder)', icon: '🏗️', tools: ['list_flows', 'get_flow', 'render_flow', 'build_ivr', 'export_ivr_spec'] },
  { name: 'Power', icon: '⚡', tools: ['twilio_api_call'] },
];

export { HOURS_GAP };
