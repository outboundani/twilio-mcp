// The shared IVR spec <-> Twilio Studio flow definition. Pure functions, no
// I/O: validateSpec, normalizeSpec, specToFlow (compose), flowToSpec
// (export), and Mermaid renderers for both. Unit tested in test/ivr.test.js,
// including the round trip: flowToSpec(specToFlow(spec)) deep-equals
// normalizeSpec(spec).
//
// The spec is a contract shared with amazon-connect-mcp (see README):
//   { name, language?, greeting?, hours?, menu: { prompt, options: [{ digit,
//     label?, action }], no_input?: { retries, message?, then } } }
//   action types: transfer_to_queue { queue, message? } | submenu { menu } |
//     previous_menu | play_message { message, then? } | voicemail { message? } |
//     hangup
//
// How each piece lands in Studio (widget types verified against
// POST /v2/Flows/Validate):
//   greeting          say-play
//   menu              gather-input-on-call (1 digit) -> split-based-on on Digits
//   transfer_to_queue [say-play] -> enqueue-call (TaskRouter workflow_sid,
//                     task_attributes {"selected_queue": "<queue>"}); the
//                     workflow routes on selected_queue == '<queue>'
//   voicemail         [say-play] -> record-voicemail
//   play_message      say-play, then its `then` (or back to the menu)
//   submenu           a child gather; previous_menu is a transition back to
//                     the parent gather
//   hangup            a transition with no next widget (Studio has NO hangup
//                     widget: the execution ends and the call drops)
//   no_input          set-variables counter -> [say-play] -> split
//                     greater_than retries; timeouts, unmatched digits, and
//                     speech all take this path
//   hours             NOT NATIVE (see HOURS_GAP)

export const ACTION_TYPES = ['transfer_to_queue', 'submenu', 'previous_menu', 'play_message', 'voicemail', 'hangup'];
export const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'];
export const MAX_DEPTH = 3;
export const QUEUE_ATTR = 'selected_queue';
export const DEFAULT_NO_INPUT = { retries: 2, then: { type: 'hangup' } };

export const HOURS_GAP = 'hours is not supported on Twilio Studio and was skipped: callers always reach the menu. Studio has no hours-of-operation or schedule widget, and its Liquid "now" date renders in US Pacific time with no timezone argument, so a clock-based Split is only correct for zones that share the US daylight-saving calendar and cannot be proven without a live call. Twilio\'s own recipe is a Twilio Function (code outside the flow), which this server does not deploy.';

// The documented normalizations that make export(build(spec)) deep-equal
// normalizeSpec(spec). Surfaced by the about tool and the README.
export const NORMALIZATIONS = [
  'language defaults to "en-US".',
  'an empty greeting is dropped.',
  'no_input defaults to { retries: 2, then: { type: "hangup" } } on every menu, and is always exported explicitly.',
  'hours is dropped (not native on Studio; reported as a gap at build time).',
  'play_message.then of { type: "hangup" } is dropped everywhere except directly on a menu option (there, a missing then means "back to this menu", so an explicit hangup is kept).',
  'an option label equal to "Press <digit>" is indistinguishable from no label and exports as no label.',
  'unknown fields are dropped.',
];

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const QUEUE_RE = /^[A-Za-z0-9 _.-]{1,64}$/;

// ---------- validation ----------

export function validateSpec(spec) {
  const errors = [];
  const gaps = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['spec must be an object'], gaps };
  if (!isStr(spec.name)) errors.push('name is required');
  else if (spec.name.length > 64) errors.push('name must be 64 characters or fewer');
  if (spec.language !== undefined && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(spec.language))) errors.push('language must look like en-US');
  if (spec.greeting !== undefined && typeof spec.greeting !== 'string') errors.push('greeting must be a string');
  if (spec.hours !== undefined) {
    const h = spec.hours;
    if (!h || typeof h !== 'object') errors.push('hours must be an object');
    else {
      if (!isStr(h.timezone)) errors.push('hours.timezone is required (e.g. America/New_York)');
      if (!Array.isArray(h.schedule) || !h.schedule.length) errors.push('hours.schedule must be a non-empty array');
      gaps.push(HOURS_GAP);
    }
  }
  if (!spec.menu || typeof spec.menu !== 'object') errors.push('menu is required');
  else validateMenu(spec.menu, 'menu', 1, false, errors);
  return { ok: errors.length === 0, errors, gaps };
}

function validateMenu(menu, p, depth, isSub, errors) {
  if (depth > MAX_DEPTH) { errors.push(`${p}: menus nest at most ${MAX_DEPTH} levels`); return; }
  if (!isStr(menu.prompt)) errors.push(`${p}.prompt is required`);
  if (!Array.isArray(menu.options) || !menu.options.length) { errors.push(`${p}.options must be a non-empty array`); return; }
  if (menu.options.length > DIGITS.length) errors.push(`${p}.options allows at most ${DIGITS.length} entries`);
  const seen = new Set();
  menu.options.forEach((o, i) => {
    const op = `${p}.options[${i}]`;
    if (!o || typeof o !== 'object') { errors.push(`${op} must be an object`); return; }
    const d = String(o.digit ?? '');
    if (!DIGITS.includes(d)) errors.push(`${op}.digit must be one of 0-9, *, #`);
    else if (seen.has(d)) errors.push(`${op}.digit ${d} is used twice in this menu`);
    seen.add(d);
    if (o.label !== undefined && typeof o.label !== 'string') errors.push(`${op}.label must be a string`);
    validateAction(o.action, `${op}.action`, depth, isSub, 'option', errors);
  });
  if (menu.no_input !== undefined) {
    const ni = menu.no_input;
    if (!ni || typeof ni !== 'object') errors.push(`${p}.no_input must be an object`);
    else {
      if (ni.retries !== undefined && !(Number.isInteger(ni.retries) && ni.retries >= 0 && ni.retries <= 5)) errors.push(`${p}.no_input.retries must be an integer 0-5`);
      if (ni.message !== undefined && typeof ni.message !== 'string') errors.push(`${p}.no_input.message must be a string`);
      if (ni.then !== undefined) validateAction(ni.then, `${p}.no_input.then`, depth, isSub, 'no_input', errors);
    }
  }
}

function validateAction(a, p, depth, isSub, ctx, errors) {
  if (!a || typeof a !== 'object') { errors.push(`${p} must be an object with a type`); return; }
  if (!ACTION_TYPES.includes(a.type)) { errors.push(`${p}.type must be one of: ${ACTION_TYPES.join(', ')}`); return; }
  switch (a.type) {
    case 'transfer_to_queue':
      if (!isStr(a.queue)) errors.push(`${p}.queue is required`);
      else if (!QUEUE_RE.test(a.queue)) errors.push(`${p}.queue may only use letters, digits, space, _, ., - (64 max)`);
      if (a.message !== undefined && typeof a.message !== 'string') errors.push(`${p}.message must be a string`);
      break;
    case 'submenu':
      if (ctx !== 'option') errors.push(`${p}: submenu is only allowed as a menu option's action`);
      else if (!a.menu || typeof a.menu !== 'object') errors.push(`${p}.menu is required`);
      else validateMenu(a.menu, `${p}.menu`, depth + 1, true, errors);
      break;
    case 'previous_menu':
      if (!isSub) errors.push(`${p}: previous_menu only works inside a submenu`);
      break;
    case 'play_message':
      if (!isStr(a.message)) errors.push(`${p}.message is required`);
      if (a.then !== undefined) validateAction(a.then, `${p}.then`, depth, isSub, 'then', errors);
      break;
    case 'voicemail':
      if (a.message !== undefined && typeof a.message !== 'string') errors.push(`${p}.message must be a string`);
      break;
    default:
      break;
  }
}

// ---------- normalization ----------

export function normalizeSpec(spec) {
  const out = { name: spec.name, language: spec.language || 'en-US' };
  if (isStr(spec.greeting)) out.greeting = spec.greeting;
  out.menu = normMenu(spec.menu);
  return out;
}

function normMenu(menu) {
  const ni = menu.no_input || {};
  const noInput = { retries: ni.retries ?? DEFAULT_NO_INPUT.retries };
  if (isStr(ni.message)) noInput.message = ni.message;
  noInput.then = normAction(ni.then || DEFAULT_NO_INPUT.then, 'no_input');
  return {
    prompt: menu.prompt,
    options: menu.options.map((o) => {
      const d = String(o.digit);
      const opt = { digit: d };
      if (isStr(o.label) && o.label !== `Press ${d}`) opt.label = o.label;
      opt.action = normAction(o.action, 'option');
      return opt;
    }),
    no_input: noInput,
  };
}

function normAction(a, ctx) {
  switch (a.type) {
    case 'transfer_to_queue': return isStr(a.message) ? { type: a.type, queue: a.queue, message: a.message } : { type: a.type, queue: a.queue };
    case 'submenu': return { type: a.type, menu: normMenu(a.menu) };
    case 'play_message': {
      const out = { type: a.type, message: a.message };
      if (a.then) {
        const then = normAction(a.then, 'then');
        if (ctx === 'option' || then.type !== 'hangup') out.then = then;
      }
      return out;
    }
    case 'voicemail': return isStr(a.message) ? { type: a.type, message: a.message } : { type: a.type };
    default: return { type: a.type };
  }
}

// Unique queue names in first-seen order.
export function specQueues(spec) {
  const out = [];
  const walkAction = (a) => {
    if (!a) return;
    if (a.type === 'transfer_to_queue' && a.queue && !out.includes(a.queue)) out.push(a.queue);
    if (a.type === 'submenu') walkMenu(a.menu);
    if (a.type === 'play_message') walkAction(a.then);
  };
  const walkMenu = (m) => {
    for (const o of m?.options || []) walkAction(o.action);
    walkAction(m?.no_input?.then);
  };
  walkMenu(spec?.menu);
  if (spec?.hours?.closed?.then) walkAction(spec.hours.closed.then);
  return out;
}

// ---------- compose: spec -> Studio flow definition ----------

const digitName = (d) => (d === '*' ? 'star' : d === '#' ? 'pound' : d);

export function specToFlow(spec, { workflowSid } = {}) {
  const v = validateSpec(spec);
  if (!v.ok) throw new Error(`Invalid IVR spec: ${v.errors.join('; ')}`);
  const s = normalizeSpec(spec);
  if (specQueues(s).length && !/^WW[0-9a-fA-F]{32}$/.test(String(workflowSid || ''))) {
    throw new Error('This spec transfers to queues, so a TaskRouter workflow SID (WW...) is required.');
  }
  const lang = s.language;
  const states = [];
  const add = (st) => { states.push(st); return st.name; };
  const to = (event, next) => (next ? { event, next } : { event });
  const say = (name, text, next) => add({ name, type: 'say-play', properties: { say: text, language: lang, loop: 1 }, transitions: [to('audioComplete', next)] });

  const compileAction = (a, prefix, c) => {
    switch (a.type) {
      case 'hangup': return null;
      case 'previous_menu': return c.parentGather;
      case 'submenu': return compileMenu(a.menu, c.childId, c.gather);
      case 'transfer_to_queue': {
        const q = add({
          name: `${prefix}_queue`,
          type: 'enqueue-call',
          properties: { workflow_sid: workflowSid, task_attributes: JSON.stringify({ [QUEUE_ATTR]: a.queue }) },
          transitions: [to('callComplete'), to('failedToEnqueue'), to('callFailure')],
        });
        return a.message ? say(`${prefix}_msg`, a.message, q) : q;
      }
      case 'voicemail': {
        const vm = add({
          name: `${prefix}_vm`,
          type: 'record-voicemail',
          properties: { transcribe: false, trim: 'trim-silence', play_beep: 'true', finish_on_key: '#', timeout: 5, max_length: 120 },
          transitions: [to('recordingComplete'), to('noAudio'), to('hangup')],
        });
        return a.message ? say(`${prefix}_msg`, a.message, vm) : vm;
      }
      case 'play_message': {
        const next = a.then ? compileAction(a.then, `${prefix}_then`, { ...c, ctx: 'then' }) : (c.ctx === 'option' ? c.gather : null);
        return say(`${prefix}_play`, a.message, next);
      }
      default: throw new Error(`Unknown action ${a.type}`);
    }
  };

  const compileNoInput = (ni, id, gather, parentGather) => {
    const thenEntry = compileAction(ni.then, `noinput_${id}_then`, { ctx: 'no_input', gather, parentGather, menuId: id });
    if (ni.retries === 0) return ni.message ? say(`noinput_${id}_msg`, ni.message, thenEntry) : thenEntry;
    const counter = `tries_${id}`;
    const input = `{{flow.variables.${counter}}}`;
    const check = add({
      name: `noinput_${id}_check`,
      type: 'split-based-on',
      properties: { input },
      transitions: [
        to('noMatch', gather),
        { ...to('match', thenEntry), conditions: [{ friendly_name: `More than ${ni.retries} tries`, arguments: [input], type: 'greater_than', value: String(ni.retries) }] },
      ],
    });
    const afterCount = ni.message ? say(`noinput_${id}_msg`, ni.message, check) : check;
    return add({
      name: `noinput_${id}_count`,
      type: 'set-variables',
      properties: { variables: [{ key: counter, value: `{{flow.variables.${counter} | plus: 1}}` }] },
      transitions: [to('next', afterCount)],
    });
  };

  const compileMenu = (menu, id, parentGather) => {
    const gather = `menu_${id}`;
    const split = `split_${id}`;
    const digits = `{{widgets.${gather}.Digits}}`;
    const noEntry = compileNoInput(menu.no_input, id, gather, parentGather);
    const matches = menu.options.map((o) => {
      const entry = compileAction(o.action, `opt_${id}_${digitName(o.digit)}`, {
        ctx: 'option', gather, parentGather, menuId: id, childId: `${id}_${digitName(o.digit)}`,
      });
      return { ...to('match', entry), conditions: [{ friendly_name: o.label || `Press ${o.digit}`, arguments: [digits], type: 'equal_to', value: o.digit }] };
    });
    add({ name: split, type: 'split-based-on', properties: { input: digits }, transitions: [to('noMatch', noEntry), ...matches] });
    add({
      name: gather,
      type: 'gather-input-on-call',
      properties: {
        say: menu.prompt, language: lang, number_of_digits: 1, stop_gather: true,
        // '#' as finish key would swallow a "#" menu choice.
        finish_on_key: menu.options.some((o) => o.digit === '#') ? '' : '#',
        timeout: 5, loop: 1,
      },
      transitions: [to('keypress', split), to('speech', noEntry), to('timeout', noEntry)],
    });
    return gather;
  };

  const main = compileMenu(s.menu, 'main', null);
  const first = s.greeting ? say('greeting', s.greeting, main) : main;
  states.unshift({
    name: 'Trigger',
    type: 'trigger',
    properties: {},
    transitions: [to('incomingMessage'), to('incomingCall', first), to('incomingConversationMessage'), to('incomingRequest'), to('incomingParent')],
  });
  layout(states);
  return {
    description: `IVR "${s.name}" composed by twilio-mcp from the shared IVR spec`,
    states,
    initial_state: 'Trigger',
    flags: { allow_concurrent_calls: true },
  };
}

// Canvas positions for the Studio editor: breadth-first from the Trigger,
// one row per hop, spread left to right.
function layout(states) {
  const byName = Object.fromEntries(states.map((s) => [s.name, s]));
  const depth = { Trigger: 0 };
  const queue = ['Trigger'];
  while (queue.length) {
    const n = queue.shift();
    for (const t of byName[n].transitions) {
      if (t.next && byName[t.next] && depth[t.next] === undefined) { depth[t.next] = depth[n] + 1; queue.push(t.next); }
    }
  }
  const cols = {};
  const order = [...states].sort((a, b) => (depth[a.name] ?? 0) - (depth[b.name] ?? 0));
  for (const s of order) {
    const d = depth[s.name] ?? 0;
    const col = cols[d] = (cols[d] ?? -1) + 1;
    s.properties.offset = { x: col * 320, y: d * 230 };
  }
  // Keep the JSON readable too: widgets listed in call-path order.
  states.splice(0, states.length, ...order);
}

// ---------- export: Studio flow definition -> spec ----------

// Returns { spec, lossy: [notes about widgets the spec cannot express] }.
// Flows this server composed round-trip exactly (modulo NORMALIZATIONS);
// hand-built flows export best-effort and say what they lost.
export function flowToSpec(definition, { name } = {}) {
  const def = typeof definition === 'string' ? JSON.parse(definition) : definition;
  const states = def?.states || [];
  const byName = Object.fromEntries(states.map((s) => [s.name, s]));
  const lossy = [];
  const nextOf = (st, event) => st?.transitions?.find((t) => t.event === event)?.next || null;

  const trigger = states.find((s) => s.type === 'trigger') || byName[def?.initial_state];
  let cur = byName[nextOf(trigger, 'incomingCall')];
  if (!cur) throw new Error('This flow has no incoming-call path (the Trigger\'s incomingCall transition goes nowhere), so there is no IVR to export.');
  const spec = { name: name || def.description || 'Exported_Flow', language: 'en-US' };
  if (cur.type === 'say-play' && byName[nextOf(cur, 'audioComplete')]?.type === 'gather-input-on-call') {
    spec.greeting = cur.properties?.say ?? '';
    if (!cur.properties?.say) lossy.push(`greeting widget "${cur.name}" plays audio (${cur.properties?.play || 'unknown'}), not text`);
    cur = byName[nextOf(cur, 'audioComplete')];
  }
  if (cur.type !== 'gather-input-on-call') {
    throw new Error(`This flow's call path starts with "${cur.name}" (${cur.type}), not a menu (Gather Input on Call). The shared spec needs a menu, so it cannot be exported.`);
  }
  spec.language = cur.properties?.language || 'en-US';
  if (spec.greeting === '') delete spec.greeting;

  const parseAction = (n, c) => {
    if (!n) return { type: 'hangup' };
    if (n === c.parentGather) return { type: 'previous_menu' };
    const st = byName[n];
    if (!st) { lossy.push(`transition to missing widget "${n}"`); return { type: 'hangup' }; }
    if (st.type === 'gather-input-on-call') {
      if (c.ctx !== 'option' || n === c.gather || c.stack.includes(n)) {
        lossy.push(`"${n}" loops back to a menu in a way the spec cannot express (only previous_menu is supported); exported as hangup`);
        return { type: 'hangup' };
      }
      if (c.depth + 1 > MAX_DEPTH) lossy.push(`menu "${n}" is nested deeper than ${MAX_DEPTH} levels`);
      return { type: 'submenu', menu: parseMenu(n, c.gather, c.depth + 1, c.stack) };
    }
    if (st.type === 'enqueue-call') return { type: 'transfer_to_queue', queue: queueOf(st) };
    if (st.type === 'record-voicemail') return { type: 'voicemail' };
    if (st.type === 'say-play') {
      const text = st.properties?.say;
      if (!text) lossy.push(`"${n}" plays audio or digits, not text`);
      const nxt = nextOf(st, 'audioComplete');
      const nt = byName[nxt]?.type;
      const composedPlay = /_play$/.test(n);
      if (!composedPlay && nt === 'enqueue-call') return { type: 'transfer_to_queue', queue: queueOf(byName[nxt]), message: text ?? '' };
      if (!composedPlay && nt === 'record-voicemail') return { type: 'voicemail', message: text ?? '' };
      const out = { type: 'play_message', message: text ?? '' };
      if (c.ctx === 'option' && nxt === c.gather) return out;
      if (!nxt) {
        if (c.ctx === 'option') out.then = { type: 'hangup' };
        return out;
      }
      const then = parseAction(nxt, { ...c, ctx: 'then' });
      if (then.type === 'submenu') { lossy.push(`"${n}" leads into a menu after playing; exported without the menu`); return out; }
      if (c.ctx === 'option' || then.type !== 'hangup') out.then = then;
      return out;
    }
    lossy.push(`widget "${n}" (${st.type}) has no equivalent in the shared spec; exported as hangup`);
    return { type: 'hangup' };
  };

  const queueOf = (st) => {
    let attrs = {};
    try { attrs = JSON.parse(st.properties?.task_attributes || '{}'); } catch { /* not JSON */ }
    if (attrs?.[QUEUE_ATTR]) return String(attrs[QUEUE_ATTR]);
    if (st.properties?.queue_name) return String(st.properties.queue_name);
    lossy.push(`enqueue widget "${st.name}" routes by workflow ${st.properties?.workflow_sid || '?'} without a ${QUEUE_ATTR} task attribute; the queue name is unknown`);
    return `workflow_${st.properties?.workflow_sid || 'unknown'}`;
  };

  const parseNoInput = (target, gather, parentGather, depth, stack) => {
    const c = { ctx: 'no_input', gather, parentGather, depth, stack };
    if (!target) return { retries: 0, then: { type: 'hangup' } };
    const st = byName[target];
    if (st?.type === 'set-variables') {
      let n = byName[nextOf(st, 'next')];
      let message;
      if (n?.type === 'say-play') { message = n.properties?.say; n = byName[nextOf(n, 'audioComplete')]; }
      const m = n?.type === 'split-based-on' && n.transitions.find((t) => t.event === 'match' && t.conditions?.[0]?.type === 'greater_than');
      if (m) {
        const out = { retries: Number(m.conditions[0].value) };
        if (message) out.message = message;
        out.then = parseAction(m.next, c);
        if (out.then.type === 'play_message' && out.then.then?.type === 'hangup') delete out.then.then;
        return out;
      }
      lossy.push(`no-input handling at "${target}" is not the retry-counter pattern; exported as no retries`);
    }
    // Composer-named no-input message (noinput_<menu id>_msg), not a then-chain widget.
    if (st?.type === 'say-play' && /^noinput_main(?:_(?:[0-9]|star|pound))*_msg$/.test(target)) {
      return { retries: 0, message: st.properties?.say, then: parseAction(nextOf(st, 'audioComplete'), c) };
    }
    return { retries: 0, then: parseAction(target, c) };
  };

  const parseMenu = (gName, parentGather, depth, stack) => {
    const g = byName[gName];
    const here = [...stack, gName];
    const menu = { prompt: g.properties?.say ?? '' };
    if (!g.properties?.say) lossy.push(`menu "${gName}" plays audio, not text`);
    const split = byName[nextOf(g, 'keypress')];
    const options = [];
    if (split?.type !== 'split-based-on') {
      lossy.push(`menu "${gName}" does not branch on the keypress with a Split; no options exported`);
    } else {
      for (const t of split.transitions.filter((x) => x.event === 'match')) {
        const cond = t.conditions?.[0] || {};
        let digit = String(cond.value ?? '').trim();
        if (cond.type !== 'equal_to') {
          const first = digit.split(/[,\s]+/)[0];
          lossy.push(`menu "${gName}" branch "${cond.friendly_name}" uses ${cond.type} "${digit}"; exported as digit ${first}`);
          digit = first;
        }
        if (!DIGITS.includes(digit)) { lossy.push(`menu "${gName}" branch "${cond.friendly_name}" does not match a single key; skipped`); continue; }
        const opt = { digit };
        const fn = cond.friendly_name;
        if (isStr(fn) && fn !== `Press ${digit}` && fn !== digit && !/^if value /i.test(fn)) opt.label = fn;
        opt.action = parseAction(t.next, { ctx: 'option', gather: gName, parentGather, depth, stack: here });
        options.push(opt);
      }
    }
    menu.options = options;
    menu.no_input = parseNoInput(nextOf(g, 'timeout'), gName, parentGather, depth, here);
    return menu;
  };

  spec.menu = parseMenu(cur.name, null, 1, []);
  return { spec, lossy };
}

// ---------- Mermaid ----------

function mLabel(s, max = 60) {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length > max) t = `${t.slice(0, max - 3)}...`;
  return t.replace(/"/g, '#quot;').replace(/[<>]/g, '').replace(/[[\]{}|]/g, ' ');
}

export function specToMermaid(spec) {
  const L = ['flowchart TD'];
  let n = 0;
  const uid = (p) => `${p}${n++}`;
  L.push(`  start(["📞 ${mLabel(spec.name)}"])`);
  let feed = 'start';
  if (spec.hours) {
    L.push('  hours{{"🕐 hours: not native on Studio, skipped"}}');
    L.push('  start -.-> hours');
  }
  if (isStr(spec.greeting)) {
    L.push(`  greet["🔊 ${mLabel(spec.greeting)}"]`);
    L.push(`  ${feed} --> greet`);
    feed = 'greet';
  }
  const drawAction = (a, fromId, edge, menuId, parentId) => {
    if (a.type === 'previous_menu') { L.push(`  ${fromId} -.->|${edge} back| ${parentId}`); return; }
    if (a.type === 'submenu') { const sub = drawMenu(a.menu, menuId); L.push(`  ${fromId} -->|${edge}| ${sub}`); return; }
    const id = uid('a');
    if (a.type === 'hangup') L.push(`  ${id}(("👋 Hang up"))`);
    else if (a.type === 'voicemail') L.push(`  ${id}[/"📼 Voicemail${a.message ? `: ${mLabel(a.message, 40)}` : ''}"/]`);
    else if (a.type === 'transfer_to_queue') L.push(`  ${id}[["🎧 Queue: ${mLabel(a.queue, 40)}${a.message ? `<br/>🔊 ${mLabel(a.message, 40)}` : ''}"]]`);
    else if (a.type === 'play_message') L.push(`  ${id}["🔈 ${mLabel(a.message, 45)}"]`);
    L.push(`  ${fromId} -->|${edge}| ${id}`);
    if (a.type === 'play_message') {
      if (a.then) drawAction(a.then, id, 'then', menuId, parentId);
      else L.push(`  ${id} -.->|back to menu| ${menuId}`);
    }
  };
  const drawMenu = (menu, parentId) => {
    const id = uid('m');
    L.push(`  ${id}{"${mLabel(menu.prompt)}"}`);
    for (const o of menu.options) drawAction(o.action, id, `${o.digit}${o.label ? ` ${mLabel(o.label, 20)}` : ''}`, id, parentId);
    const ni = { ...DEFAULT_NO_INPUT, ...(menu.no_input || {}) };
    drawAction(ni.then, id, `no input x${ni.retries + 1}`, id, parentId);
    return id;
  };
  const main = drawMenu(spec.menu, null);
  L.push(`  ${feed} --> ${main}`);
  return L.join('\n');
}

const ICONS = {
  trigger: '📞', 'say-play': '🔊', 'gather-input-on-call': '🔢', 'split-based-on': '🔀', 'set-variables': '🧮',
  'enqueue-call': '🎧', 'record-voicemail': '📼', 'connect-call-to': '☎️', 'make-http-request': '🌐', 'run-function': '⚙️',
  'send-message': '💬', 'send-to-flex': '🧑‍💼',
};

// Generic render of ANY Studio flow: one node per widget, edges per event.
export function definitionToMermaid(definition) {
  const def = typeof definition === 'string' ? JSON.parse(definition) : definition;
  const ids = {};
  (def.states || []).forEach((s, i) => { ids[s.name] = `w${i}`; });
  const L = ['flowchart TD'];
  for (const s of def.states || []) {
    const p = s.properties || {};
    const detail = p.say || (s.type === 'enqueue-call' ? (p.task_attributes || p.queue_name || '') : '') || p.input || '';
    const text = `${ICONS[s.type] || '▫️'} ${mLabel(s.name, 40)}${detail ? `<br/>${mLabel(detail, 50)}` : ''}`;
    if (s.type === 'gather-input-on-call' || s.type === 'split-based-on') L.push(`  ${ids[s.name]}{"${text}"}`);
    else if (s.type === 'trigger') L.push(`  ${ids[s.name]}(["${text}"])`);
    else L.push(`  ${ids[s.name]}["${text}"]`);
  }
  for (const s of def.states || []) {
    for (const t of s.transitions || []) {
      if (!t.next || !ids[t.next]) continue;
      const label = t.event === 'match' ? mLabel(t.conditions?.[0]?.friendly_name || t.conditions?.[0]?.value || 'match', 24) : t.event;
      const dotted = ['timeout', 'noMatch', 'speech'].includes(t.event);
      L.push(`  ${ids[s.name]} ${dotted ? '-.->' : '-->'}|${label}| ${ids[t.next]}`);
    }
  }
  return L.join('\n');
}
