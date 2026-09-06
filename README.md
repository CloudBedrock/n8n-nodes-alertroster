# n8n-nodes-alertroster

n8n community node for [AlertRoster](https://alertroster.com), the CloudBedrock
call-out notification and escalation platform. Raise and drive incidents, read
and edit on-call schedules, act on shift handoffs and overrides, run
dead-man's-switch check-ins, and start workflows when incidents change state.

- [Installation](#installation)
- [Credentials](#credentials)
- [AlertRoster node](#alertroster-node)
- [AlertRoster Trigger node](#alertroster-trigger-node)
- [Development](#development)

## Installation

In n8n go to **Settings → Community Nodes → Install** and enter
`n8n-nodes-alertroster`. Or on a self-hosted instance:

```sh
cd ~/.n8n && npm install n8n-nodes-alertroster
```

Restart n8n. Two nodes appear: **AlertRoster** and **AlertRoster Trigger**.

## Credentials

AlertRoster has two kinds of API credential. Which one a node needs depends on
the resource you pick; the UI asks for exactly one.

### AlertRoster Integration Key

For the **Event** and **Incident** resources. Paste one of:

| Key prefix | Minted where | Use with |
|---|---|---|
| `ark_async_…` | **Sources** page, "async" lane | Event (fire-and-forget ingest) |
| `ark_sync_…` | **Sources** page, "sync" lane | Incident (create, read, update, ack, resolve, reassign) |
| `art_…` | Account API token (currently minted only from the server console by an operator) | Incident; every create must name a **Source ID** |

A key is bound to one lane. The node checks the prefix against the operation
before calling the server and tells you which kind it wanted. Base URL defaults
to `https://alertroster.com`; set it to your own host for a self-hosted
instance. HTTPS is required except for localhost.

### AlertRoster Responder

For everything else (Responder Incident, User, Schedule, Layer, Handoff,
Override, Check-In) and for the Trigger node. Enter the responder's **email**
and **password**. Responders normally sign in by magic link, so the password is
opt-in: set one under Settings in AlertRoster first. Leave **Account ID** blank
unless the email belongs to more than one account; the node then lists the
account ids in its error so you can pick one.

The node signs in, caches the 15-minute access token in workflow static data,
and signs in again when it expires or is rejected. Admin-only operations
(schedule and layer edits, overrides) need a responder with the `admin` role.

## AlertRoster node

Every response is unwrapped to the object it describes; list operations emit
one item per record. Timestamps are ISO 8601 strings. Whole-number fields are
sent as integers because the server refuses strings.

### Event (`ark_async_` key)

| Operation | Notes |
|---|---|
| Trigger | Dedup key, summary, severity (`critical`, `error`, `warning`, `info`); optional source and custom details JSON. Opens an incident or folds into the open one for that key. |
| Acknowledge | Dedup key. |
| Resolve | Dedup key. |

Returns `{ status: "accepted", alert_id, dedup_key }`. Ingest is asynchronous.

### Incident (`ark_sync_` key or `art_` token)

| Operation | Notes |
|---|---|
| Create | Dedup key, title; optional urgency (`high`, `low`), priority (`normal`, `high`, `emergency`, capped by the source's maximum), local grace seconds (0-3600), source ID (required for `art_` tokens). A repeat with the same dedup key returns the open incident. |
| Get | By incident ID. |
| Update | Title, urgency, priority. |
| Acknowledge / Resolve | By incident ID. |
| Reassign | Incident ID and responder user ID. |

### Responder Incident

| Operation | Notes |
|---|---|
| Get Many | The account's open incidents, newest first. There is no pagination and no closed-incident listing. |
| Get | By ID, open or closed. |
| Acknowledge / Resolve / Reassign | As this responder. |
| Silence | Stops the noise for 90 seconds (fixed server-side) without acknowledging. Only on `triggered` incidents. |
| Get Search | The search panel for a missed check-in: `positions` (the trail, newest first, each with `fix_at` and `captured_at`), `commands`, `locate` and `beacon` availability with a `reason` when not, and `subject` (the frozen `stated` description plus the live `profile`, or `null`). On an incident not raised by a check-in the panel is empty and both capabilities report `not_a_checkin_incident`. |
| Locate | Asks the subject's device for a fresh position. Returns the queued `command` (202); poll Get Search or Get for the fix. |
| Beacon | Mode `steady`, `strobe` or `off`. Lights the subject's torch for 900 seconds; send again to keep it going. Returns the queued `command`. On a duress incident the request is refused with `409 duress_confirmation_required` unless **Confirm Duress** is on; `off` needs no consent. |

Get Search, Locate and Beacon need the subject's consent (`409 consent_missing`)
and an open incident (`409 incident_closed`). Photo URLs in `subject.profile`
are presigned and expire in minutes; every photograph carries `taken_at` and
`age_days`, and anything that shows the image should show its age.

### User

| Operation | Notes |
|---|---|
| Get Many | Responders in the account (`id`, `name`, `email`, `role`), up to 500. |

### Schedule

| Operation | Notes |
|---|---|
| Get Many / Get | |
| Create | Name, IANA time zone; optional first rotation (starts at, length seconds, member IDs). Admin. Returns `{ schedule, layers }`. |
| Update | Name, time zone. Admin. |
| Delete | Admin. Returns `{ schedule, unlinked_sources }`. |
| Get On-Call | Optional `at`. Returns `{ at, on_call }` where `on_call` names the user and whether a layer or override put them there. |
| Get Roster | Optional `from` and `to` (default: now to +7 days, max 90 days). Returns `{ from, to, segments }`. |

### Layer (admin except Get Many)

| Operation | Notes |
|---|---|
| Get Many | By schedule ID. |
| Create | Schedule ID, name, position, rotation start, rotation length seconds, member IDs in rotation order, optional restrictions. |
| Update | Name, position, rotation start, rotation length. |
| Delete | |
| Set Members | Replaces the whole member list; order is the rotation. Empty empties it. |
| Set Restrictions | Replaces the whole list. Each row: day of week (or every day), start and end time as `HH:MM:SS` in the schedule's time zone. An end at or before the start wraps past midnight. |

### Handoff

| Operation | Notes |
|---|---|
| Get Many | Handoffs this responder asked for or was asked to take; optional status filter (`pending`, `accepted`, `declined`, `cancelled`). |
| Create | Schedule ID, to user ID, kind (`cover` or `handoff`), starts at, ends at. |
| Accept / Decline | Only the addressee. |
| Cancel | The requester, or an admin. |

### Override

| Operation | Notes |
|---|---|
| Create | Schedule ID, user ID, starts at, ends at. Admin. |
| Cancel | Override ID. Admin, or the responder who created it. |

### Check-In

Check-ins belong to the signed-in responder; the account must have check-ins
enabled.

| Operation | Notes |
|---|---|
| Get Many | Each check-in carries a `details` object (wearing, origin, destination) or `null`. |
| Create | Label, kind (`timer` or `daily`; daily needs time zone and local time), optional reminder lead seconds and escalation schedule ID. New check-ins are idle. |
| Update | Label, reminder lead, time zone, local time, escalation schedule ID (`none` clears). Kind cannot change. |
| Delete | |
| Arm | Timer: deadline (future, within 7 days). Daily: no fields. |
| Extend | By seconds; optional expected deadline as a guard against racing another client. |
| Satisfy / Cancel | Optional code when the check-in requires one. |
| Set Require Code | Boolean. |
| Get Code Status / Set Code / Clear Code / Clear Duress Code | Codes are 6-12 digits. |
| Get Location Opt-In / Set Location Opt-In | Whether positions are stored with transitions. |
| Get Details Opt-In / Set Details Opt-In | Whether a search description is stored. Opting out deletes the profile and every stored description. |
| Get Profile / Set Profile | The reusable vehicle description (make, model, colour, year, plate). A blank text field clears it; a year of 0 clears the year. Set is refused with `409 consent_missing` until the responder opts in. |
| Set Details | Check-in ID plus wearing, origin, destination (text and/or coordinates) for one check-in. Blanks clear. Refused with `409 consent_missing` until the responder opts in; coordinates are dropped (returned `null`) unless location is also opted in. |

Arm, Extend, Satisfy and Cancel accept an optional **Location** (latitude,
longitude, accuracy, fix time) and an optional **Details** object with the same
fields as Set Details. The server stores either only if the responder has
opted in, never fails the transition over them, and never reports whether it
kept them. Read the check-in back to see what it holds.

## AlertRoster Trigger node

AlertRoster does not send outbound webhooks, so this is a polling trigger
using the Responder credential. Pick the events to watch:

| Event | Fires when |
|---|---|
| Incident Triggered | A new incident appears in the open list |
| Incident Acknowledged | An open incident moves to `acknowledged` |
| Incident Resolved | An incident leaves the open list; the node fetches it by ID and reports its final status (`resolved`, `auto_resolved`, or `expired`) |

Each item is `{ event, incident }`. On first activation the node records what
is already open and emits nothing. A manual test run shows the current open
incidents as samples without changing that state. Set the poll interval in the
node; one request per poll plus one per incident that closed.

## Development

```sh
npm install --ignore-scripts   # isolated-vm (via n8n-workflow) need not build
npm run build                  # tsc + icon copy into dist/
npm run lint
npm run check:coverage         # routes called vs the published OpenAPI spec
npm run dev                    # tsc --watch
```

`check:coverage` fetches AlertRoster's OpenAPI document and fails when the
API has an operation this node neither implements nor excuses in
`scripts/openapi-coverage-allowlist.json`, or when the node calls a route the
API no longer documents. The allowlist is the list of server surface the node
deliberately lacks, each entry with its reason. CI (`.github/workflows/ci.yml`)
runs build, lint and this check on every pull request and on pushes to `main`;
a spec that cannot be fetched is a CI warning, drift is a failure.

To try it locally, link the package into your n8n custom directory:

```sh
npm run build && npm link
cd ~/.n8n/custom && npm link n8n-nodes-alertroster
```

Design notes live in `docs/superpowers/specs/`. Issues and pull requests:
<https://github.com/CloudBedrock/n8n-nodes-alertroster>.

## License

MIT © CloudBedrock
