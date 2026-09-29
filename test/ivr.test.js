// The shared IVR spec <-> Studio flow definition: composer, exporter,
// round trip, and renderers. Pure, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateSpec, normalizeSpec, specToFlow, flowToSpec, specToMermaid, definitionToMermaid,
  specQueues, HOURS_GAP, DIGITS,
} from '../src/ivr.js';
import { definitionProblems, SAFE_WIDGETS } from '../src/rules.js';

const EXAMPLE = JSON.parse(readFileSync(new URL('../examples/main-line.json', import.meta.url), 'utf8'));
const WW = `WW${'a'.repeat(32)}`;
const NAME_RE = /^[a-zA-Z]+[\w+,-]*$/; // Twilio's own widget-name pattern (from a Validate error)
const COND_TYPES = new Set(['equal_to', 'greater_than']);

const clone = (x) => JSON.parse(JSON.stringify(x));
const roundTrip = (spec) => flowToSpec(specToFlow(spec, { workflowSid: WW }), { name: spec.name });

function assertWellFormed(def) {
  const names = new Set(def.states.map((s) => s.name));
  assert.equal(names.size, def.states.length, 'widget names are unique');
  for (const s of def.states) {
    assert.match(s.name, NAME_RE, `widget name ${s.name}`);
    assert.ok(SAFE_WIDGETS.has(s.type), `widget type ${s.type}`);
    for (const t of s.transitions) {
      if (t.next) assert.ok(names.has(t.next), `${s.name} -> ${t.next} exists`);
      for (const c of t.conditions || []) assert.ok(COND_TYPES.has(c.type), c.type);
    }
    if (s.type === 'gather-input-on-call') {
      assert.deepEqual(s.transitions.map((t) => t.event), ['keypress', 'speech', 'timeout']);
      assert.equal(s.properties.number_of_digits, 1);
    }
  }
  assert.deepEqual(definitionProblems(def), [], 'composed flows pass the raw tool\'s own definition rails');
}

test('the launch-plan example validates, reports hours as a gap, and names its queues', () => {
  const v = validateSpec(EXAMPLE);
  assert.ok(v.ok, v.errors.join('; '));
  assert.deepEqual(v.gaps, [HOURS_GAP]);
  assert.deepEqual(specQueues(EXAMPLE), ['Sales', 'Support', 'Support_Escalations', 'Billing']);
});

test('the example composes to a well-formed Studio flow', () => {
  const def = specToFlow(EXAMPLE, { workflowSid: WW });
  assertWellFormed(def);
  assert.equal(def.initial_state, 'Trigger');
  assert.equal(def.states[0].name, 'Trigger');
  const trigger = def.states[0];
  assert.equal(trigger.transitions.find((t) => t.event === 'incomingCall').next, 'greeting');
  const enq = def.states.filter((s) => s.type === 'enqueue-call');
  assert.equal(enq.length, 4);
  for (const e of enq) {
    assert.equal(e.properties.workflow_sid, WW);
    assert.ok(JSON.parse(e.properties.task_attributes).selected_queue);
    assert.ok(e.transitions.every((t) => !t.next), 'enqueue ends the flow');
  }
  // previous_menu is a transition back to the parent gather.
  const sub = def.states.find((s) => s.name === 'split_main_2');
  assert.equal(sub.transitions.find((t) => t.conditions?.[0]?.value === '9').next, 'menu_main');
  // no_input: counter -> message -> check (greater_than retries) -> hangup (no next)
  const count = def.states.find((s) => s.name === 'noinput_main_count');
  assert.equal(count.type, 'set-variables');
  assert.equal(count.transitions[0].next, 'noinput_main_msg');
  const check = def.states.find((s) => s.name === 'noinput_main_check');
  const m = check.transitions.find((t) => t.event === 'match');
  assert.equal(m.conditions[0].type, 'greater_than');
  assert.equal(m.conditions[0].value, '2');
  assert.equal(m.next, undefined, 'hangup is a transition with no next');
  assert.equal(check.transitions.find((t) => t.event === 'noMatch').next, 'menu_main');
});

test('ROUND TRIP: export(build(example)) deep-equals normalizeSpec(example)', () => {
  const { spec, lossy } = roundTrip(EXAMPLE);
  assert.deepEqual(lossy, []);
  assert.deepEqual(spec, normalizeSpec(EXAMPLE));
  assert.equal(spec.hours, undefined, 'hours is a documented gap');
});

const KITCHEN_SINK = {
  name: 'Kitchen_Sink',
  language: 'es-MX',
  greeting: 'Hola.',
  menu: {
    prompt: 'Main menu.',
    options: [
      { digit: '1', label: 'Hours', action: { type: 'play_message', message: 'We are open nine to five.' } },
      { digit: '2', action: { type: 'play_message', message: 'Goodbye.', then: { type: 'hangup' } } },
      { digit: '3', action: { type: 'play_message', message: 'One moment.', then: { type: 'transfer_to_queue', queue: 'Sales' } } },
      { digit: '4', action: { type: 'voicemail' } },
      { digit: '5', action: { type: 'voicemail', message: 'Leave it at the beep.' } },
      { digit: '6', action: { type: 'hangup' } },
      { digit: '*', label: 'Star', action: { type: 'transfer_to_queue', queue: 'VIP Line', message: 'VIP!' } },
      { digit: '#', label: 'Pound', action: { type: 'play_message', message: 'Pound.', then: { type: 'play_message', message: 'Again.', then: { type: 'voicemail' } } } },
      {
        digit: '0',
        action: {
          type: 'submenu',
          menu: {
            prompt: 'Level two.',
            options: [
              { digit: '1', action: { type: 'play_message', message: 'Back you go.', then: { type: 'previous_menu' } } },
              {
                digit: '2',
                action: {
                  type: 'submenu',
                  menu: {
                    prompt: 'Level three.',
                    options: [
                      { digit: '1', action: { type: 'transfer_to_queue', queue: 'Deep' } },
                      { digit: '9', action: { type: 'previous_menu' } },
                    ],
                    no_input: { retries: 0, message: 'Nothing? Back up.', then: { type: 'previous_menu' } },
                  },
                },
              },
              { digit: '9', action: { type: 'previous_menu' } },
            ],
            no_input: { retries: 1, then: { type: 'play_message', message: 'Bye now.', then: { type: 'hangup' } } },
          },
        },
      },
    ],
    no_input: { retries: 0, then: { type: 'voicemail', message: 'No input, leave a message.' } },
  },
};

test('ROUND TRIP: a kitchen-sink spec (3 levels, *, #, every action, every no_input shape)', () => {
  const def = specToFlow(KITCHEN_SINK, { workflowSid: WW });
  assertWellFormed(def);
  const { spec, lossy } = roundTrip(KITCHEN_SINK);
  assert.deepEqual(lossy, []);
  assert.deepEqual(spec, normalizeSpec(KITCHEN_SINK));
});

test('a "#" option clears the gather finish key; menus without one keep "#"', () => {
  const def = specToFlow(KITCHEN_SINK, { workflowSid: WW });
  assert.equal(def.states.find((s) => s.name === 'menu_main').properties.finish_on_key, '');
  assert.equal(def.states.find((s) => s.name === 'menu_main_0').properties.finish_on_key, '#');
});

test('normalizations are exactly the documented ones', () => {
  const n = normalizeSpec({
    name: 'N', greeting: '', extra: 1,
    hours: { timezone: 'America/New_York', schedule: [{}] },
    menu: {
      prompt: 'p',
      options: [
        { digit: '1', label: 'Press 1', action: { type: 'play_message', message: 'm' } },
        { digit: '2', action: { type: 'play_message', message: 'm', then: { type: 'play_message', message: 'n', then: { type: 'hangup' } } } },
      ],
    },
  });
  assert.deepEqual(n, {
    name: 'N',
    language: 'en-US',
    menu: {
      prompt: 'p',
      options: [
        { digit: '1', action: { type: 'play_message', message: 'm' } },
        { digit: '2', action: { type: 'play_message', message: 'm', then: { type: 'play_message', message: 'n' } } },
      ],
      no_input: { retries: 2, then: { type: 'hangup' } },
    },
  });
});

// Deterministic random specs: every one must round-trip exactly.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function randomSpec(r, i) {
  const pickOne = (xs) => xs[Math.floor(r() * xs.length)];
  const leaf = (isSub, ctx) => {
    const types = ['transfer_to_queue', 'play_message', 'voicemail', 'hangup', ...(isSub ? ['previous_menu'] : [])];
    const t = pickOne(types);
    const a = { type: t };
    if (t === 'transfer_to_queue') { a.queue = pickOne(['Sales', 'Support', 'Billing_2']); if (r() < 0.5) a.message = 'xfer'; }
    if (t === 'voicemail' && r() < 0.5) a.message = 'vm';
    if (t === 'play_message') { a.message = `msg${i}`; if (r() < 0.6 && ctx !== 'deep') a.then = leaf(isSub, 'deep'); }
    return a;
  };
  const menu = (depth, isSub) => {
    const n = 1 + Math.floor(r() * 5);
    const digits = [...DIGITS].sort(() => r() - 0.5).slice(0, n);
    const m = {
      prompt: `menu ${depth}`,
      options: digits.map((d) => {
        const o = { digit: d, action: depth < 3 && r() < 0.25 ? { type: 'submenu', menu: menu(depth + 1, true) } : leaf(isSub, 'option') };
        if (r() < 0.4) o.label = `L${d}`;
        return o;
      }),
    };
    if (r() < 0.7) {
      m.no_input = { retries: Math.floor(r() * 4), then: leaf(isSub, 'no_input') };
      if (m.no_input.then.type === 'play_message' && !m.no_input.then.then && r() < 0.5) m.no_input.then.then = { type: 'hangup' };
      if (r() < 0.5) m.no_input.message = 'again';
    }
    return m;
  };
  const spec = { name: `Rand_${i}`, menu: menu(1, false) };
  if (r() < 0.5) spec.greeting = 'hi';
  return spec;
}

test('ROUND TRIP: 300 random specs all survive build -> export exactly', () => {
  const r = rng(20260929);
  for (let i = 0; i < 300; i++) {
    const spec = randomSpec(r, i);
    const v = validateSpec(spec);
    assert.ok(v.ok, `${JSON.stringify(spec)}: ${v.errors.join('; ')}`);
    const def = specToFlow(spec, { workflowSid: WW });
    assertWellFormed(def);
    const { spec: back, lossy } = flowToSpec(def, { name: spec.name });
    assert.deepEqual(lossy, [], JSON.stringify(spec));
    assert.deepEqual(back, normalizeSpec(spec), JSON.stringify(spec));
  }
});

test('spec validation catches the contract violations', () => {
  const errs = (patch) => validateSpec({ name: 'X', menu: { prompt: 'p', options: [{ digit: '1', action: { type: 'hangup' } }] }, ...patch }).errors;
  assert.ok(errs({ name: '' }).some((e) => e.includes('name is required')));
  assert.ok(errs({ menu: { prompt: 'p', options: [{ digit: '1', action: { type: 'previous_menu' } }] } }).some((e) => e.includes('only works inside a submenu')));
  assert.ok(errs({ menu: { prompt: 'p', options: [{ digit: '1', action: { type: 'hangup' } }, { digit: '1', action: { type: 'hangup' } }] } }).some((e) => e.includes('used twice')));
  assert.ok(errs({ menu: { prompt: 'p', options: [{ digit: '10', action: { type: 'hangup' } }] } }).some((e) => e.includes('digit')));
  assert.ok(errs({ menu: { prompt: 'p', options: [{ digit: '1', action: { type: 'transfer_to_queue', queue: "Sales' or 1==1" } }] } }).some((e) => e.includes('queue may only')));
  assert.ok(errs({ menu: { prompt: 'p', options: [{ digit: '1', action: { type: 'dial', number: '+15555550100' } }] } }).some((e) => e.includes('type must be one of')));
  assert.ok(errs({ menu: { prompt: 'p', options: [{ digit: '1', action: { type: 'hangup' } }], no_input: { retries: 9, then: { type: 'submenu', menu: {} } } } }).some((e) => e.includes('retries')));
  assert.ok(errs({ menu: { prompt: 'p', options: [{ digit: '1', action: { type: 'hangup' } }], no_input: { then: { type: 'submenu', menu: {} } } } }).some((e) => e.includes('only allowed as a menu option')));
  const deep = (n) => (n === 0 ? { prompt: 'p', options: [{ digit: '1', action: { type: 'hangup' } }] } : { prompt: 'p', options: [{ digit: '1', action: { type: 'submenu', menu: deep(n - 1) } }] });
  assert.ok(validateSpec({ name: 'X', menu: deep(2) }).ok, 'three levels is fine');
  assert.ok(errs({ menu: deep(3) }).some((e) => e.includes('at most 3 levels')));
});

test('specToFlow refuses to compose queue transfers without a real workflow SID', () => {
  assert.throws(() => specToFlow(EXAMPLE, {}), /workflow SID/);
  assert.throws(() => specToFlow(EXAMPLE, { workflowSid: 'WW123' }), /workflow SID/);
  const noQueues = { name: 'Q', menu: { prompt: 'p', options: [{ digit: '1', action: { type: 'voicemail' } }] } };
  assert.doesNotThrow(() => specToFlow(noQueues, {}));
});

test('export of a hand-built flow is best-effort and names what it lost', () => {
  const def = {
    initial_state: 'Trigger',
    states: [
      { name: 'Trigger', type: 'trigger', properties: {}, transitions: [{ event: 'incomingCall', next: 'g' }] },
      { name: 'g', type: 'gather-input-on-call', properties: { say: 'Press 1 or 2', language: 'en-GB' }, transitions: [{ event: 'keypress', next: 's' }, { event: 'timeout' }] },
      {
        name: 's', type: 'split-based-on', properties: { input: '{{widgets.g.Digits}}' },
        transitions: [
          { event: 'noMatch' },
          { event: 'match', next: 'http', conditions: [{ friendly_name: 'If value equal_to 1', type: 'equal_to', value: '1', arguments: [] }] },
          { event: 'match', next: 'q', conditions: [{ friendly_name: 'two', type: 'equal_to', value: '2', arguments: [] }] },
        ],
      },
      { name: 'http', type: 'make-http-request', properties: {}, transitions: [] },
      { name: 'q', type: 'enqueue-call', properties: { queue_name: 'support' }, transitions: [] },
    ],
  };
  const { spec, lossy } = flowToSpec(def, { name: 'Hand_Built' });
  assert.equal(spec.language, 'en-GB');
  assert.deepEqual(spec.menu.options, [
    { digit: '1', action: { type: 'hangup' } },
    { digit: '2', label: 'two', action: { type: 'transfer_to_queue', queue: 'support' } },
  ]);
  assert.deepEqual(spec.menu.no_input, { retries: 0, then: { type: 'hangup' } });
  assert.ok(lossy.some((l) => l.includes('make-http-request')));
  assert.ok(validateSpec(spec).ok, 'an export is always a valid spec');
});

test('export refuses flows with no call path or no menu, precisely', () => {
  assert.throws(() => flowToSpec({ states: [{ name: 'Trigger', type: 'trigger', transitions: [{ event: 'incomingCall' }] }] }), /no incoming-call path/);
  assert.throws(() => flowToSpec({
    states: [
      { name: 'Trigger', type: 'trigger', transitions: [{ event: 'incomingCall', next: 'x' }] },
      { name: 'x', type: 'enqueue-call', properties: {}, transitions: [] },
    ],
  }), /not a menu/);
});

test('mermaid: spec view shows back-navigation, no-input, and the hours gap; flow view shows every widget', () => {
  const m = specToMermaid(EXAMPLE);
  assert.match(m, /^flowchart TD/);
  assert.match(m, /-\.->\|9 back\|/);
  assert.match(m, /hours: not native on Studio/);
  assert.match(m, /no input x3/);
  assert.ok(!m.includes('"Sales\''));
  const def = specToFlow(EXAMPLE, { workflowSid: WW });
  const g = definitionToMermaid(def);
  assert.match(g, /^flowchart TD/);
  assert.equal((g.match(/^ {2}w\d+[[({]/gm) || []).length, def.states.length);
});

test('house style: no em dashes anywhere in the repo', () => {
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    if (['node_modules', '.git', '.wrangler', '.env', '.dev.vars'].includes(f)) return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const offenders = walk(root).filter((p) => /\.(js|mjs|json|md|toml)$/.test(p) && readFileSync(p, 'utf8').includes(String.fromCharCode(0x2014)));
  assert.deepEqual(offenders, []);
});
