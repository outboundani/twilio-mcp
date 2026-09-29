# twilio-mcp

**Your Twilio contact center, in your AI's hands.** An open-source MCP server for Twilio on Cloudflare Workers. Zero dependencies, no terminal required, and its whole purpose is to **build**: TaskRouter workspaces, agent activities, queues, and workflows - and **Studio IVRs**: real flows with nested submenus, composed from one portable IVR spec, diagrammed in chat before build, validated by Twilio's own Validate endpoint, and saved as drafts.

> It builds, not just reads.

Prompt Claude (or any MCP client):

- *"build me a contact center on Twilio: sales, support, support escalations, and billing queues, a workflow that routes to them, and a main line IVR. show me the diagram first"*
- *"give me the contact center overview - what routes where, and what is actually live"*
- *"draw my Main Line flow as a diagram"*
- *"export Main Line to the IVR spec"* (then hand that spec to [amazon-connect-mcp](https://github.com/outboundani/amazon-connect-mcp) and build the same IVR there)
- *"which numbers point at which flows?"*
- *"put it on our main number and start taking calls"* (refused, politely, with a pre-flight checklist - see below)

The IVR builder composes the real Studio flow JSON, shows you the flow as a Mermaid diagram in chat, runs it through `POST /v2/Flows/Validate` (Twilio's own validator, errors relayed verbatim), then saves it as a **draft**.

## What it deliberately does NOT do

- **Never dials.** No Calls API, no conferences, and no Studio Executions (POSTing an Execution starts a flow by placing a real outbound call).
- **Never sends.** No Messages, SMS, or Conversations.
- **Never touches a phone number.** Numbers are read only: never bought, released, or repointed. Pointing a number at a flow IS going live, and a human does that in the Twilio Console.
- **No deletes.** There are no delete tools, and both the HTTP client and the raw API tool refuse `DELETE`.

These are code, not prompts: every non-GET request passes a path-template allowlist inside the HTTP client itself, typed tools included, and the raw API tool normalizes before it allowlists on top of that. Unit tested.

## Deploy your own in 3 steps

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/outboundani/twilio-mcp)

1. **Deploy**: click the button (free Cloudflare account), or `git clone` + `npx wrangler deploy`. The CONFIG KV namespace is auto-provisioned.
2. **Create a Twilio API key**: Twilio Console → Account → API keys & tokens → **Create API key** (Standard). Copy the SID (SK...) and the secret (shown once). Never use the account auth token: a key can be revoked on its own.
3. **Configure**: open `/setup` on your new Worker and paste your Account SID (AC...), the API Key SID, and the secret. The wizard validates them live against Twilio, then hands you your access key for MCP clients (shown once).

Prefer terminal-managed config? Set Wrangler secrets instead; they override the wizard: `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `MCP_AUTH_TOKEN`. A server with Twilio credentials and no access key refuses MCP traffic (fail closed).

## Connect your AI

The MCP endpoint is `https://<your-worker>/mcp`.

- **Claude (web/desktop)**: Settings → Connectors → Add custom connector → paste the URL. When the authorization screen appears, paste your access key.
- **Claude Code**: `claude mcp add --transport http twilio https://<your-worker>/mcp` and authenticate when prompted.
- **ChatGPT**: Settings → Connectors → Advanced → Developer mode → add the MCP server URL.
- **Anything else**: standard streamable HTTP MCP with OAuth 2.1 (or send the access key as a Bearer token).

Then try: *"give me the contact center overview."*

## The toolbox (18 tools)

| Group | Tools |
|---|---|
| 🔌 Account & Overview | `about`, `check_connection`, `contact_center_overview` |
| 📇 Phone Numbers (read only) | `list_phone_numbers` (shows what each number's voice URL runs: a Studio flow by name, a TwiML app, a SIP trunk, a webhook, or nothing) |
| 🎯 TaskRouter (Queues & Routing) | `list_workspaces`, `list_task_queues`, `list_workflows`, `list_activities`, `list_workers`, `create_workspace` ✏️, `create_task_queue` ✏️, `create_workflow` ✏️ |
| 🏗️ Studio (IVR Builder) | `list_flows`, `get_flow`, `render_flow`, `build_ivr` ✏️, `export_ivr_spec` |
| ⚡ Power | `twilio_api_call` ✏️ (reads the account, numbers, TwiML apps, flows, and TaskRouter config; writes only Studio flows and TaskRouter build objects; refuses DELETE, calls, messages, numbers, executions, tasks, workers, credentials, and webhook URLs; redacts secrets) |

✏️ = writes to your account. Reads are always safe; connected AIs are instructed to confirm before every write.

## Twilio vocabulary (worth 30 seconds)

- A **Studio flow** is the IVR. It has a draft and a published revision, and callers only ever reach it when a phone number points at it.
- A **phone number** runs a flow when its "A call comes in" webhook is the flow's webhook URL. That wiring is the go-live moment.
- A **TaskRouter workspace** is the routing brain: **activities** are agent states, **task queues** hold waiting calls and target agents by an expression over their attributes (`skills HAS 'Sales'`), and a **workflow** decides which queue a call lands in.
- The IVR hands a call to TaskRouter with an **Enqueue Call** widget. This server's convention: the task attribute `selected_queue` carries the queue name, and every workflow route is `selected_queue == '<queue>'`. `create_workflow` builds exactly those routes from the same IVR spec `build_ivr` uses.

## The shared IVR spec

`build_ivr` and `export_ivr_spec` speak one portable JSON spec, the same one amazon-connect-mcp builds from. Build on Twilio, export, build on Connect: that is the migration.

```json
{
  "name": "Main_Line",
  "language": "en-US",
  "greeting": "Thanks for calling Acme Home Services.",
  "menu": {
    "prompt": "For sales, press 1. For support, press 2. For billing, press 3.",
    "options": [
      { "digit": "1", "label": "Sales", "action": { "type": "transfer_to_queue", "queue": "Sales", "message": "Connecting you to sales." } },
      { "digit": "2", "label": "Support", "action": { "type": "submenu", "menu": {
          "prompt": "For a new issue, press 1. For an existing ticket, press 2. To go back, press 9.",
          "options": [
            { "digit": "1", "action": { "type": "transfer_to_queue", "queue": "Support" } },
            { "digit": "2", "action": { "type": "transfer_to_queue", "queue": "Support_Escalations" } },
            { "digit": "9", "action": { "type": "previous_menu" } }
          ] } } },
      { "digit": "3", "label": "Billing", "action": { "type": "transfer_to_queue", "queue": "Billing" } }
    ],
    "no_input": { "retries": 2, "message": "Sorry, I didn't catch that.", "then": { "type": "hangup" } }
  }
}
```

Action types: `transfer_to_queue` (optional `message`), `submenu` (3 levels max), `previous_menu`, `play_message` (optional `then`; without one it returns to its menu), `voicemail` (optional `message`), `hangup`. The full example, with `hours`, is [`examples/main-line.json`](examples/main-line.json).

**How it lands in Studio:** menus are Gather Input on Call widgets (one digit) with a Split on the digits; `previous_menu` is a transition back to the parent gather; `transfer_to_queue` is an optional Say/Play plus an Enqueue Call into the workflow; `voicemail` is Record Voicemail; `hangup` is a transition to nowhere (Studio has no hangup widget); `no_input` is a per-menu retry counter (Set Variables + Split `greater_than`) that timeouts, wrong keys, and speech all feed.

**The one declared gap: `hours`.** Studio has no hours-of-operation or schedule widget, and its Liquid clock (`"now"`) renders in US Pacific time with no timezone argument, so a clock-based Split is only right for zones that share the US daylight-saving calendar and can't be proven without a live call. Twilio's own recipe is a Function, which is code outside the flow. So `build_ivr` skips `hours`, says so in its response and its diagram, and callers always reach the menu. When you migrate, hours come back on a platform that has them natively (Amazon Connect does): the exported spec has no hours, so you add them there.

**Round trip, exactly.** `export_ivr_spec(build_ivr(spec))` deep-equals the spec after these documented normalizations: `language` defaults to `en-US`; an empty `greeting` is dropped; every menu gets an explicit `no_input` (default `{ retries: 2, then: { type: "hangup" } }`); `hours` is dropped; `play_message.then` of `hangup` is dropped except directly on a menu option (where no `then` means "back to this menu"); a label equal to `Press <digit>` exports as no label; unknown fields are dropped. The unit tests prove it on the example, a kitchen-sink spec, and 300 random specs; the live smoke proves it on the definition Twilio actually stored. Hand-built flows export best-effort, and everything the spec cannot express is listed in `lossy`.

## "Put it live" gets a checklist, not a phone call

Ask it to point a number at the flow or start taking calls and it refuses, then hands you the pre-flight checklist: review the draft in the Studio canvas, publish it, confirm each queue has workers whose attributes match its target expression and an available activity, set the number's "A call comes in" to the flow in the Console, place a test call. A human presses go.

## For the nerds

- **Zero dependencies.** Not one npm package. Plain JS on `fetch` and Web Crypto, HTTP Basic with an API key.
- **The raw tool is normalize-then-ALLOWLIST from day one** (the pattern this series hardened after an audit of its first blocklist guard): host pinned to `api`/`studio`/`taskrouter.twilio.com` with no overrides or lookalikes; paths must be plain segments (no `%`, `;`, `\`, `#`, `?`, empty or dot segments, so no traversal and no `//evil.com`); `api.twilio.com` paths are bound to the configured account; every read and write matches an explicit method + path template with typed SID placeholders; query keys are identifiers, unique across case; form bodies refuse case-duplicate keys and any `*Url`/`*Callback` parameter (no webhook egress); flow definitions written through it may only use the IVR widget vocabulary; secrets are redacted. And the HTTP client enforces the write allowlist again underneath.
- **The API landmines, all hit live and encoded in the code:**
  - Studio's `Validate` is a schema check, not a reference check: a made-up `workflow_sid` passes, unknown widget properties pass, Split condition types are not checked. `build_ivr` checks the workflow and its routes itself first.
  - There is no hangup widget. The widget type enum has 44 entries and none of them hangs up.
  - Widget names must match `^[a-zA-Z]+[\w+,-]*$`. "menu main" is rejected.
  - Gather has no DTMF-only switch in the flow schema, so its `speech` event must be routed or a caller who says "sales" gets hung up on.
  - `finish_on_key: "#"` swallows a `#` menu choice; the composer clears it when a menu uses `#`.
  - POSTing a Studio Execution places a real outbound call. It looks like a harmless test endpoint.
  - Twilio creates AND updates with POST, so the allowlist is by path template, never by verb.
  - Studio rewrites your definition on save (every Set Variables entry gains `"type": "string"`), so compare meaning, not bytes.
  - A task queue in a single-tasking workspace fails with 20001 "Activity Sids cannot be empty" unless it names reservation and assignment activities the docs call optional. `create_task_queue` wires Twilio's seeded Reserved and Busy.
  - New workspaces arrive seeded with Offline, Idle, Busy, and Reserved; `create_workspace` fills the gaps (Unavailable, Break) without adding a second ready state.
  - The Account resource carries an `auth_token` field (empty under API-key auth, redacted regardless). Two pagination dialects: `meta.next_page_url` (absolute) and `next_page_uri` (relative); the client follows both only on the pinned host.
- **OAuth 2.1 built in** (dynamic client registration, PKCE, stateless HMAC-signed tokens), so it plugs straight into Claude and ChatGPT as a connector.
- Tested against a live Twilio account: 45 unit tests (`npm test`) plus a 38-step live smoke suite (`npm run smoke`, read-only by default; `-- --writes` builds an `MCP_Test_` workspace, four queues, a workflow, and a draft flow from the example spec, then proves the round trip on what Twilio stored). No calls, no numbers, no trial credit spent.

## Scoping the API key

A Standard API key can do anything the account can. That is exactly why the rails live in this Worker's code rather than in a prompt. If your account offers restricted API keys, grant only Studio and TaskRouter plus read access to phone numbers. For extra distance, run it against a subaccount that owns only the contact center, and rotate the key whenever it has been pasted anywhere.

## License

MIT. Built by [Ryan Shatzkamer](https://www.linkedin.com/in/ryanshatzkamer) (Director, Technical Services @ [outboundIQ](https://outboundiq.com)) - creator of [five9-mcp](https://github.com/outboundani/five9-mcp), [genesys-mcp](https://github.com/outboundani/genesys-mcp), and [cxone-mcp](https://github.com/outboundani/cxone-mcp). This is platform number four.
