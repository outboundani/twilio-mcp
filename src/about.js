// Operator context - surfaced to connected AI models via the MCP `instructions`
// field on initialize and the `about` tool. Edit freely; this is the place to
// tell the AI who runs this server and how it should behave.

import { NORMALIZATIONS } from './ivr.js';

export const ABOUT = `## About this server

twilio-mcp connects AI models to a Twilio account through the Studio,
TaskRouter, and core REST APIs. Its whole purpose is to **build** a contact
center: TaskRouter workspaces, agent activities, task queues, and workflows,
and Studio IVR flows composed from a shared IVR spec, diagrammed in chat,
and validated by Twilio's own Validate endpoint before anything is saved.

**Operator:** Ryan Shatzkamer ([linkedin.com/in/ryanshatzkamer](https://www.linkedin.com/in/ryanshatzkamer)) -
Director, Technical Services at **outboundIQ**, contact center architect
(80+ platform deployments), and creator of
[five9-mcp](https://github.com/outboundani/five9-mcp),
[genesys-mcp](https://github.com/outboundani/genesys-mcp), and
[cxone-mcp](https://github.com/outboundani/cxone-mcp). This is platform
number four.

**Why this exists:** Twilio is the most programmable contact center stack
there is, and it is also the easiest one to hurt yourself with: the same
API key that builds a queue can place a call, send a text, or repoint a
live phone number. This server takes the build half and refuses the other
half in code. Nothing dials, nothing is sent, nothing is deleted, and no
phone number is ever touched. A human presses go.

## Twilio vocabulary (it differs from Five9, Genesys, and CXone)

- A **Studio flow** is the IVR. It has a DRAFT and a PUBLISHED revision;
  callers only ever hit the published one, and only when a number points
  at the flow.
- A **phone number** runs a flow when its voice URL ("A call comes in") is
  the flow's webhook URL. That wiring IS going live, and this server never
  does it.
- A **TaskRouter workspace** is the routing brain: **activities** are agent
  states (Available, Offline, Break), **task queues** hold waiting work and
  target agents by an expression over their attributes (skills HAS 'Sales'),
  and a **workflow** decides which queue a task lands in.
- The IVR hands a call to TaskRouter with an **Enqueue Call** widget that
  names a workflow and sets task attributes. This server's convention:
  \`selected_queue\` carries the queue name, and every workflow route is
  \`selected_queue == '<queue>'\`.

## How to behave

- Reads are always safe. **Confirm with the user before any write** (tools
  badged WRITE), restating exactly what will be created.
- **Create-only bias.** There are no delete tools and the raw tool refuses
  DELETE. Existing names are refused rather than overwritten; build_ivr's
  replace_draft is the one exception, and it only ever saves a DRAFT
  revision (the published one keeps serving).
- In THIS account (the operator's trial sandbox), prefix test artifacts
  with MCP_Test_ so they are identifiable, and never spend trial credit on
  calls or numbers.
- Most tools take a NAME and resolve it; a workspace or workflow can be
  omitted when there is exactly one. Ambiguity comes back as a list: relay
  it and ask.
- When the user asks for a build without every detail (names, prompt copy),
  choose clean professional values and show them in the plan or diagram:
  one approval pass, not a round of questions. **Approval means go**: run
  the chain without re-asking at each step.
- If tools fail with 401/20003, run check_connection: the API key may be
  revoked, or it may belong to a different account than the Account SID.

## The hard lines (code-level, unit tested)

- **Never dials.** No Calls API, no conferences, and no Studio Executions:
  POSTing an Execution starts a flow by placing a real outbound call.
- **Never sends.** No Messages, SMS, or Conversations.
- **Never touches a phone number.** Numbers are read only: never bought,
  released, or repointed. If the user asks to "put it on our number" or
  "go live", refuse politely and give the pre-flight checklist instead:
  (1) review the diagram and the draft in the Studio canvas, (2) publish it,
  (3) confirm the workflow's queues have workers with matching skills and an
  Available activity, (4) in Console > Phone Numbers, set "A call comes in"
  to the Studio flow, (5) place a test call. A human does steps 2 to 5.
- **Never deletes.**
- twilio_api_call rails: host pinned to api/studio/taskrouter.twilio.com;
  paths must be plain segments (no %, ?, #, ;, \\, dot or empty segments);
  api.twilio.com paths are bound to this account; reads and writes are
  allowlisted method + path templates; *Url and *Callback parameters are
  refused (no webhook egress); flow definitions written through it may use
  only the IVR widget vocabulary (no outbound call, message, HTTP, Function,
  or Flex widgets); secrets are redacted. A refusal is final: do not
  rephrase the request to get around it.

## Building a contact center (the playbook)

1. contact_center_overview first: reuse what exists.
2. Propose the whole plan in one message: workspace, queues, workflow, the
   IVR spec, and render_flow's Mermaid diagram of it. Get ONE approval.
3. create_workspace -> create_workflow (pass the IVR spec and
   create_missing_queues: true; it creates every queue the IVR names and
   one route per queue) -> build_ivr (same spec). Or create_task_queue
   one by one when the user wants custom target expressions.
4. build_ivr always runs Twilio's Validate first and relays its errors
   verbatim; the flow is saved as a DRAFT unless the user asked to publish.
   Publishing a new flow is harmless (no number points at it). Say so, and
   say what is NOT done: nothing is live until a human points a number at
   the flow.
5. export_ivr_spec turns any flow back into the shared spec: that is the
   migration path to another platform (amazon-connect-mcp speaks the same
   spec).

## The shared IVR spec on Studio

- Menus are Gather Input on Call widgets (one digit) with a Split on the
  digits. Submenus nest 3 levels; previous_menu is a transition back to the
  parent menu.
- no_input: timeouts, unmatched digits, and anything spoken all count as a
  failed try. A per-menu counter (Set Variables + Split greater_than) gives
  \`retries\` re-prompts, the optional message plays on each failure, then
  \`then\` runs. Default: 2 retries, then hang up.
- hangup is a transition with no next widget: Studio has no hangup widget.
- **hours is a declared gap.** Studio has no schedule widget and its Liquid
  clock cannot convert time zones, so build_ivr skips hours and says so.
  Callers always reach the menu. Say this plainly whenever hours come up.
- Round-trip normalizations (export(build(spec)) equals the spec after):
${NORMALIZATIONS.map((n) => `  - ${n}`).join('\n')}

## API landmines (all verified live against a real account - trust these over the docs)

- **Studio's Validate endpoint is a schema check, not a reference check.**
  A made-up workflow_sid passes. Unknown widget properties pass silently.
  Split condition types and Set Variables entries are not checked at all.
  build_ivr checks the workflow and its routes itself before it composes.
- **There is no "DTMF only" switch in the Gather widget's flow JSON** (an
  \`input\` property passes Validate but is not in the widget schema), so treat speech as on:
  every Gather must route its \`speech\` event too. Unrouted, a caller who
  says "sales" gets hung up on.
- **There is no hangup widget.** The widget type enum has 44 entries and none
  of them hangs up: a transition with no next widget ends the execution and
  the call drops.
- **Widget names must match ^[a-zA-Z]+[\\w+,-]*$**: no spaces, no leading
  digit. Validate rejects "menu main" and "1_sales".
- **Liquid's "now" renders in US Pacific time** with no timezone argument.
  Any clock-based business-hours Split is quietly wrong outside that DST
  calendar. That is why hours is a declared gap, not a hack.
- **finish_on_key "#" swallows a "#" menu choice** (the key ends the gather
  with empty Digits). The composer clears the finish key when a menu uses #.
- **POSTing a Studio Execution places a real outbound call.** It looks like a
  harmless "test run" endpoint. It is refused everywhere.
- **Twilio creates AND updates with POST** (no PUT or PATCH), so "allow POST
  to create" is also "allow POST to modify": the write allowlist is by path
  template, never by verb.
- **The Account resource returns an auth_token field** (empty under API-key
  auth, but present). Raw responses are redacted regardless.
- **Two pagination dialects:** Studio and TaskRouter page with an absolute
  meta.next_page_url; the 2010 API pages with a relative next_page_uri. The
  client follows both, and only while they stay on the same pinned host.
- **Single-tasking queues need two activity SIDs the docs call optional.**
  Creating a task queue in a single-tasking workspace fails with 20001
  "Activity Sids cannot be empty" unless it names a ReservationActivitySid
  and an AssignmentActivitySid. create_task_queue wires them to Twilio's
  seeded Reserved and Busy activities.
- **New workspaces are not empty:** Twilio seeds Offline, Idle (the one
  available state), Busy, and Reserved. Adding your own "Available" on top
  gives agents two ready states; create_workspace does not.
- **Studio rewrites your flow on save:** every Set Variables entry comes back
  with "type": "string" added. A byte diff of sent vs stored always differs;
  compare meaning, not bytes (export_ivr_spec does). The retry counter is
  therefore a string, and retries are capped at 5 so a string or numeric
  greater_than agree.
- **Draft vs published:** saving a flow with Status draft never changes what
  live callers hear; only publishing does. build_ivr's replace_draft relies
  on that, and refuses to publish over a flow any number points at.`;

// Short version for the MCP initialize handshake.
export const INSTRUCTIONS = `MCP server for Twilio (Studio + TaskRouter), operated by Ryan Shatzkamer (Director, Technical Services at outboundIQ; creator of five9-mcp, genesys-mcp, and cxone-mcp). Its purpose is BUILDING a contact center: TaskRouter workspaces, activities, queues, and workflows, and Studio IVR flows composed from a shared IVR spec, diagrammed in chat (render_flow) before build, validated by Twilio's own Validate endpoint, and saved as drafts. export_ivr_spec reads any flow back into the same spec for migration. Call the "about" tool for the vocabulary, the build playbook, and the verified API landmine list. Reads are safe; confirm before WRITE tools. Hard lines in code: it never deletes, never places calls or starts Studio Executions, never sends messages, and never buys, releases, or repoints a phone number - a human presses go.`;
