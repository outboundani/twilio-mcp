// Pure safety rails. No I/O here, so everything that decides "is this
// allowed / what gets sent" is unit tested in test/rules.test.js.
//
// The raw API tool (twilio_api_call) follows the series' normalize-then-
// ALLOWLIST pattern (ringcx-mcp src/rules.js):
//   1. refuse anything a URL parser or Twilio's router could read differently
//      than we do (encoding, dot segments, empty segments, ?, #, ;, \),
//   2. pin the host to Twilio's official API hosts (no overrides, no
//      lookalikes) and bind api.twilio.com paths to the configured account,
//   3. allow only listed (method, path template) pairs - everything else,
//      including every DELETE, is refused,
//   4. check the query and form body instead of trusting them.
//
// The same WRITE allowlist also guards the HTTP client itself (see
// isAllowedWrite), so a typed tool can never place a call, send a message,
// touch a phone number, or start a Studio Execution either. Defense in depth.

// ---------- hosts ----------

export const HOSTS = {
  api: 'api.twilio.com',
  studio: 'studio.twilio.com',
  taskrouter: 'taskrouter.twilio.com',
};

// Accepts exactly a host key (api|studio|taskrouter) or its exact hostname.
// Anything else (lookalikes, ports, schemes, userinfo) is null.
export function resolveHost(h) {
  const s = String(h ?? '').trim().toLowerCase();
  if (HOSTS[s]) return s;
  const key = Object.keys(HOSTS).find((k) => HOSTS[k] === s);
  return key || null;
}

// ---------- SIDs and templates ----------

// Twilio SIDs: a two-letter prefix plus 32 hex characters.
export const SID = (prefix) => `${prefix}[0-9a-fA-F]{32}`;
export const isSid = (v, prefix) => new RegExp(`^${SID(prefix)}$`).test(String(v ?? ''));

const TOKENS = {
  '{AC}': SID('AC'), '{PN}': SID('PN'), '{AP}': SID('AP'), '{QU}': SID('QU'),
  '{FW}': SID('FW'), '{FN}': SID('FN'), '{FT}': SID('FT'),
  '{WS}': SID('WS'), '{WQ}': SID('WQ'), '{WW}': SID('WW'), '{WA}': SID('WA'), '{WK}': SID('WK'), '{TC}': SID('TC'),
  '{REV}': '\\d+',
};
// Escape the template's literal dots first, then splice in the SID patterns.
const R = (s) => new RegExp(`^${s.replace(/\./g, '\\.').replace(/\{[A-Z]+\}/g, (t) => TOKENS[t])}$`);
const T = (host, path) => [host, R(path)];

// Reads (GET). Deliberately NOT here: Calls, Messages, Recordings,
// Transcriptions (call content and PII), Keys and SigningKeys (credentials),
// AvailablePhoneNumbers (the shopping aisle for buying numbers).
const READS = [
  T('api', '2010-04-01/Accounts/{AC}.json'),
  T('api', '2010-04-01/Accounts/{AC}/IncomingPhoneNumbers.json'),
  T('api', '2010-04-01/Accounts/{AC}/IncomingPhoneNumbers/{PN}.json'),
  T('api', '2010-04-01/Accounts/{AC}/Applications.json'),
  T('api', '2010-04-01/Accounts/{AC}/Applications/{AP}.json'),
  T('api', '2010-04-01/Accounts/{AC}/Queues.json'),
  T('api', '2010-04-01/Accounts/{AC}/Queues/{QU}.json'),
  T('studio', 'v2/Flows'),
  T('studio', 'v2/Flows/{FW}'),
  T('studio', 'v2/Flows/{FW}/Revisions'),
  T('studio', 'v2/Flows/{FW}/Revisions/{REV}'),
  T('studio', 'v2/Flows/{FW}/Executions'),
  T('studio', 'v2/Flows/{FW}/Executions/{FN}'),
  T('studio', 'v2/Flows/{FW}/Executions/{FN}/Steps'),
  T('studio', 'v2/Flows/{FW}/Executions/{FN}/Context'),
  T('taskrouter', 'v1/Workspaces'),
  T('taskrouter', 'v1/Workspaces/{WS}'),
  T('taskrouter', 'v1/Workspaces/{WS}/Statistics'),
  T('taskrouter', 'v1/Workspaces/{WS}/Activities'),
  T('taskrouter', 'v1/Workspaces/{WS}/Activities/{WA}'),
  T('taskrouter', 'v1/Workspaces/{WS}/TaskQueues'),
  T('taskrouter', 'v1/Workspaces/{WS}/TaskQueues/{WQ}'),
  T('taskrouter', 'v1/Workspaces/{WS}/TaskQueues/{WQ}/Statistics'),
  T('taskrouter', 'v1/Workspaces/{WS}/Workflows'),
  T('taskrouter', 'v1/Workspaces/{WS}/Workflows/{WW}'),
  T('taskrouter', 'v1/Workspaces/{WS}/Workflows/{WW}/Statistics'),
  T('taskrouter', 'v1/Workspaces/{WS}/Workers'),
  T('taskrouter', 'v1/Workspaces/{WS}/Workers/{WK}'),
  T('taskrouter', 'v1/Workspaces/{WS}/TaskChannels'),
  T('taskrouter', 'v1/Workspaces/{WS}/TaskChannels/{TC}'),
];

// Writes (Twilio creates AND updates with POST). This list is the whole
// write surface of the server: build objects, validate flows, nothing else.
// Nothing on api.twilio.com is writable at all (numbers, calls, messages,
// applications), and TaskRouter Tasks and Workers are out of scope (live
// work and agent state).
export const WRITES = [
  T('studio', 'v2/Flows'),
  T('studio', 'v2/Flows/Validate'),
  T('studio', 'v2/Flows/{FW}'),
  T('taskrouter', 'v1/Workspaces'),
  T('taskrouter', 'v1/Workspaces/{WS}/Activities'),
  T('taskrouter', 'v1/Workspaces/{WS}/TaskQueues'),
  T('taskrouter', 'v1/Workspaces/{WS}/TaskQueues/{WQ}'),
  T('taskrouter', 'v1/Workspaces/{WS}/Workflows'),
  T('taskrouter', 'v1/Workspaces/{WS}/Workflows/{WW}'),
];

export const WRITE_FAMILIES = 'Studio flows (create, update as draft only, validate) and TaskRouter workspaces, activities, task queues, and workflows (create and update)';

// Used by the HTTP client on EVERY non-GET request, typed tools included.
export function isAllowedWrite(hostKey, method, path) {
  if (String(method).toUpperCase() !== 'POST') return false;
  const rel = String(path ?? '').replace(/^\/+/, '');
  return WRITES.some(([h, r]) => h === hostKey && r.test(rel));
}

// ---------- secrets ----------

const normKey = (k) => String(k).toLowerCase().replace(/[_-]/g, '');
// The Account resource carries auth_token (empty under API-key auth, but
// never trust that); keys and credentials resources carry secrets.
const SECRET_KEY = /authtoken|secret|passw|credential|apikey|privatekey|signingkey/;
const isSecretKey = (k) => SECRET_KEY.test(normKey(k));

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = isSecretKey(k) && v !== null && v !== '' ? '[redacted]' : redactSecrets(v);
  return out;
}

// ---------- Studio definition rails ----------

// Widget types a flow written through this server may contain: the
// composer's own vocabulary. No outbound calls (make-outgoing-call-*,
// connect-call-to), no messages (send-message, send-and-wait-for-reply),
// no external egress (make-http-request, run-function, add-twiml-redirect),
// no Flex handoff.
export const SAFE_WIDGETS = new Set(['trigger', 'say-play', 'gather-input-on-call', 'split-based-on', 'set-variables', 'enqueue-call', 'record-voicemail']);

// Returns a list of problems (empty = fine). Also refuses any *_url
// property (hold music, callbacks, recording webhooks): no egress.
export function definitionProblems(definition) {
  let def = definition;
  if (typeof def === 'string') {
    try { def = JSON.parse(def); } catch { return ['Definition is not valid JSON.']; }
  }
  if (!def || typeof def !== 'object' || !Array.isArray(def.states)) return ['Definition must be an object with a states array.'];
  const problems = [];
  for (const s of def.states) {
    if (!SAFE_WIDGETS.has(s?.type)) problems.push(`widget "${s?.name}" has type "${s?.type}", which is outside this server's allowed set (${[...SAFE_WIDGETS].join(', ')})`);
    for (const k of Object.keys(s?.properties || {})) {
      if (/_?ur[li]$/i.test(k) || /callback/i.test(k)) problems.push(`widget "${s?.name}" sets ${k} (external URLs are not allowed)`);
    }
  }
  return problems;
}

// ---------- the raw-API guard ----------

const refuse = (message) => ({ ok: false, message });
const MAX_DEPTH = 32;

function hasCaseDuplicateKeys(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > MAX_DEPTH) return false;
  if (Array.isArray(obj)) return obj.some((x) => hasCaseDuplicateKeys(x, depth + 1));
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  if (new Set(keys).size !== keys.length) return true;
  return Object.values(obj).some((v) => hasCaseDuplicateKeys(v, depth + 1));
}

// Specific, polite refusals for the families this server exists to NOT
// touch. Checked before the generic allowlist message.
function familyRefusal(hostKey, m, segs) {
  const lower = segs.map((s) => s.toLowerCase().replace(/\.json$/, ''));
  if (lower.includes('calls') || lower.includes('conferences') || lower.includes('participants')) {
    return 'Refused: this server never places, modifies, or reads live calls (Calls, Conferences, Participants). Nothing dials.';
  }
  if (lower.includes('messages') || lower.includes('sms') || lower.includes('conversations')) {
    return 'Refused: this server never sends messages (Messages, SMS, Conversations).';
  }
  if (lower.includes('availablephonenumbers')) {
    return 'Refused: this server never buys numbers, and it does not browse the number store either. Buying a number is a human decision in the Twilio Console.';
  }
  if (lower.includes('incomingphonenumbers') && m !== 'GET') {
    return 'Refused: this server never changes a phone number (voice URL, SMS URL, configuration) and never buys or releases one. Pointing a number at a flow is the go-live moment, and a human does that in the Twilio Console.';
  }
  if (hostKey === 'studio' && lower.includes('executions') && m !== 'GET') {
    return 'Refused: POSTing a Studio Execution starts the flow and places a real outbound call. This server never starts executions.';
  }
  if (hostKey === 'taskrouter' && (lower.includes('tasks') || lower.includes('reservations')) && m !== 'GET') {
    return 'Refused: creating or updating TaskRouter Tasks and Reservations is live work routing, out of scope by design.';
  }
  if (hostKey === 'taskrouter' && lower.includes('workers') && m !== 'GET') {
    return 'Refused: worker writes (creating agents, changing their activity) are out of scope. Agents manage their own state.';
  }
  if (lower.includes('keys') || lower.includes('signingkeys') || lower.includes('credentials')) {
    return 'Refused: credentials (Keys, SigningKeys, Credentials) are out of scope.';
  }
  return null;
}

// Validates a raw call. Returns { ok: true, host, method, path, query, form }
// with the exact values to send, or { ok: false, message }. Nothing is sent
// unless this says ok. `accountSid` binds api.twilio.com paths to the
// configured account (no wandering into subaccounts or other accounts).
export function checkRawCall({ host, method, path, query, body } = {}, { accountSid } = {}) {
  const m = String(method ?? '').toUpperCase();
  if (m === 'DELETE') return refuse('Refused: this server ships no deletes, and the raw tool refuses DELETE by design.');
  if (!['GET', 'POST'].includes(m)) return refuse(`Refused: method ${m || '(none)'} is not allowed. Twilio uses GET to read and POST to create or update.`);

  const hostKey = resolveHost(host ?? 'api');
  if (!hostKey) return refuse(`Refused: host must be one of ${Object.values(HOSTS).join(', ')} (or api, studio, taskrouter). Got ${JSON.stringify(host)}.`);

  // Path: validate BEFORE any URL is built.
  if (typeof path !== 'string' || !path) return refuse('Refused: path is required.');
  if (/[%;\\#?]/.test(path)) return refuse('Refused: the path may not contain %, ;, \\, #, or ? - pass query parameters in `query`.');
  if (/\s/.test(path)) return refuse('Refused: the path may not contain whitespace.');
  const rel = path.replace(/^\//, '');
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return refuse('Refused: empty, "." and ".." path segments are not allowed (that includes a leading "//" host override).');
  if (segs.some((s) => !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(s))) return refuse('Refused: path segments may only contain letters, digits, _, -, and inner dots.');

  const fam = familyRefusal(hostKey, m, segs);
  if (fam) return refuse(fam);

  // Account binding.
  if (hostKey === 'api') {
    const acct = segs[0] === '2010-04-01' && segs[1] === 'Accounts' ? segs[2]?.replace(/\.json$/, '') : null;
    if (!acct || !accountSid || acct !== accountSid) return refuse('Refused: api.twilio.com paths must start with 2010-04-01/Accounts/<your account SID> - this server is bound to its configured account.');
  }

  // Query: identifier keys, no case-insensitive duplicates, scalars only.
  if (query !== undefined && query !== null && (typeof query !== 'object' || Array.isArray(query))) return refuse('Refused: query must be an object of name/value pairs.');
  const q = query || {};
  const qkeys = Object.keys(q);
  if (qkeys.some((k) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(k))) return refuse('Refused: query parameter names must be plain identifiers (letters, digits, _).');
  const qlower = qkeys.map((k) => k.toLowerCase());
  if (new Set(qlower).size !== qlower.length) return refuse('Refused: duplicate query parameters (including case variants) are not allowed.');
  const sendQuery = {};
  for (const k of qkeys) {
    const v = q[k];
    if (v !== null && typeof v === 'object') return refuse(`Refused: query value for ${k} must be a single scalar.`);
    if (v === undefined || v === null || v === '') continue;
    sendQuery[k] = String(v);
  }

  // Body: form parameters. Objects only, never on GET.
  if (body !== undefined && body !== null) {
    if (m === 'GET') return refuse('Refused: GET calls take no body - use `query`.');
    if (typeof body !== 'object' || Array.isArray(body)) return refuse('Refused: the body must be a single object of form parameters.');
  }
  const b = body || {};
  if (hasCaseDuplicateKeys(b)) return refuse('Refused: the body repeats a field name with different casing - ambiguous to the server.');
  const form = {};
  for (const [k, v] of Object.entries(b)) {
    if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(k)) return refuse(`Refused: form parameter "${k}" is not a plain identifier.`);
    if (/ur[li]$|callback/i.test(k)) return refuse(`Refused: ${k} would point Twilio at an external URL (webhook egress). Not allowed through the raw tool.`);
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      if (!['definition', 'configuration', 'attributes'].includes(k.toLowerCase())) return refuse(`Refused: form parameter ${k} must be a scalar (only Definition, Configuration, and Attributes may be JSON objects).`);
      form[k] = JSON.stringify(v);
    } else {
      form[k] = String(v);
    }
  }

  // Allowlist.
  const table = m === 'GET' ? READS : WRITES;
  if (!table.some(([h, r]) => h === hostKey && r.test(rel))) {
    return refuse(`Refused: ${m} ${HOSTS[hostKey]}/${rel} is not on the raw tool's allowlist. Reads cover the account, phone numbers (read only), TwiML apps, Studio flows and their revisions/executions, and TaskRouter configuration. Writes are limited to ${WRITE_FAMILIES}. Deletes, calls, messages, numbers, executions, tasks, workers, and credentials are out of scope.`);
  }

  // Studio write rules.
  if (m === 'POST' && hostKey === 'studio' && rel !== 'v2/Flows/Validate') {
    const statusKey = Object.keys(form).find((k) => k.toLowerCase() === 'status');
    const status = statusKey ? form[statusKey] : undefined;
    const defKey = Object.keys(form).find((k) => k.toLowerCase() === 'definition');
    if (rel === 'v2/Flows') {
      if (!['draft', 'published'].includes(status)) return refuse('Refused: creating a flow needs Status "draft" or "published". (Publishing a NEW flow is harmless: no phone number points at it yet.)');
      if (!defKey) return refuse('Refused: creating a flow needs a Definition.');
    } else if (status !== 'draft') {
      return refuse('Refused: updates to an existing flow go through the raw tool only with Status "draft". The published revision keeps serving callers untouched; publishing over a live flow is a human decision (or use build_ivr, which checks that no number points at the flow first).');
    }
    if (defKey) {
      const problems = definitionProblems(form[defKey]);
      if (problems.length) return refuse(`Refused: the flow definition ${problems.join('; ')}.`);
    }
  }

  return { ok: true, host: hostKey, method: m, path: rel, query: sendQuery, form: m === 'POST' ? form : undefined };
}

// ---------- argument validation (MCP schemas are advisory; enforce them) ----------

function typeOk(v, t) {
  if (t === 'string') return typeof v === 'string';
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'boolean') return typeof v === 'boolean';
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return true;
}

export function validateArgs(schema, args, path = 'arguments') {
  const errors = [];
  const walk = (s, v, p) => {
    if (!s || v === undefined) return;
    if (s.type && !typeOk(v, s.type)) { errors.push(`${p} must be ${s.type}`); return; }
    if (s.enum && !s.enum.includes(v)) errors.push(`${p} must be one of: ${s.enum.join(', ')}`);
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${p} must be >= ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${p} must be <= ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${p} needs at least ${s.minItems} item(s)`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${p} allows at most ${s.maxItems} item(s)`);
      if (s.items) v.forEach((x, i) => walk(s.items, x, `${p}[${i}]`));
    }
    if (s.type === 'object' && v && typeof v === 'object') {
      for (const r of s.required || []) if (v[r] === undefined) errors.push(`${p}.${r} is required`);
      for (const [k, x] of Object.entries(v)) {
        if (s.properties?.[k]) walk(s.properties[k], x, `${p}.${k}`);
        else if (s.additionalProperties === false) errors.push(`${p}.${k} is not a known argument`);
      }
    }
  };
  walk(schema, args ?? {}, path);
  return errors;
}
