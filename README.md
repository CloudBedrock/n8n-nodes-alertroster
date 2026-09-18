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

### AlertRoster Webhook Secret

For the **AlertRoster Webhook Trigger** only: the signing secret of one
endpoint created on AlertRoster's Webhooks page. It is shown once there.

### AlertRoster Responder

For everything else (Responder Incident, User, Schedule, Layer, Handoff,
Override, Check-In, Record, Source, Escalation Policy) and for the Trigger node. Enter the responder's **email**
and **password**. Responders normally sign in by magic link, so the password is
opt-in: set one under Settings in AlertRoster first. Leave **Account ID** blank
unless the email belongs to more than one account; the node then lists the
account ids in its error so you can pick one.

The node signs in, caches the 15-minute access token in workflow static data,
and signs in again when it expires or is rejected. Admin-only operations
(schedule and layer edits, overrides) need a responder with the `admin` role.

### Operating notes

- **Tier.** Integration keys and account tokens are minted from the
  **Duty of Care** tier up (the gate is on minting, so a key that exists keeps
  working), and the scheduling layer (schedules, layers, overrides, handoffs)
  is available from the Lone Worker tier up. Below that the server answers
  `403` with a plan refusal, which the node surfaces as the error message.
- **Fresh versus stale tokens.** The server lets a lapsed access token
  through for five more minutes on the incident list, incident get and
  timeline, acknowledge, resolve, reassign, silence and the user list, and on
  nothing else on the incident side. The check-in transitions (arm, extend,
  satisfy, cancel) and the briefing get the grace too; check-in create, edit,
  delete and the code routes, every schedule, layer, override and handoff
  write, and the search, report and context routes want a current token. The node signs
  in again a minute before its cached token expires, so this only shows up if
  a workflow is run against a session cache another host filled long ago.
- **Rate limits.** There is no rate limit on the incident list, so the
  trigger's poll interval is a cost choice, not a quota one. Password sign-in
  is throttled at 30 per 15 minutes per IP address, which is why the session
  is cached and shared across executions rather than logging in per item.

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

#### Who holds an incident, and who is being asked

Every incident the node returns (Incident, Responder Incident, and the
trigger) carries `assigned_to_user_id` and `paged_user_ids`, and they answer
different questions. `assigned_to_user_id` is who holds the incident now. On a
source that escalates to a schedule it is set at trigger to whoever is on call,
set again on every escalation, and moved by Reassign. `paged_user_ids` is who is
being asked right now: everybody the current escalation-policy rung woke, in the
order the rung names them. It is `[]` on every incident that is not on a policy
rung, and Acknowledge, Reassign and Resolve all empty it.

A null `assigned_to_user_id` is not on its own a broadcast to the whole account.
On a `triggered` incident, read the pair together:

| `assigned_to_user_id` | `paged_user_ids` | Meaning |
|---|---|---|
| set | `[]` | One named responder holds it: the schedule's on-call at trigger or escalation, or whoever acknowledged it or was reassigned it. |
| `null` | non-empty | An escalation policy rung is waiting on those responders. Nobody holds the incident until one of them acknowledges. |
| `null` | `[]` | Either the incident is inside its local grace (`escalate_at` is in the future and nobody off-site has been paged yet), or the source names no schedule or nobody is on call, and every responder in the account was paged. |

Once an incident is acknowledged or closed, `paged_user_ids` is always `[]` and
says nothing about who was paged; an acknowledgement over the Incident resource
or an expired ladder leaves `assigned_to_user_id` null as well, so the table
above does not apply to them.

Two related fields are easy to misread. `acknowledged_by_user_id` is history,
never overwritten, and stays `null` when the Incident resource acknowledged
over an integration key, because no responder did it; take "acknowledged" from
`status`. A policy rung firing changes `paged_user_ids` and `escalation_rule_position`
but not `status`, so the trigger does not fire for it; poll Get if a workflow
needs to follow the ladder.

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
| Share Report | Mints the public link to the one-page missing-person report for a missed check-in, or returns the link already live (one per incident, so a printed QR code keeps working; the node cannot tell the two apart, compare `created_at` if it matters). Returns the report: `id` (the link, not the incident), `incident_id`, `url`, `expires_at` (seven days), `created_at`, `created_by_user_id`, `view_count`, `last_viewed_at`. `409 not_a_checkin_incident` on an incident a monitor raised; `409 incident_closed` after stand-down. |
| Get Report | The live link and its `view_count` / `last_viewed_at` as `{ shared: true, incident_id, ...report }`, or `{ shared: false, incident_id }` when nothing has been shared. Answers on a closed incident too. |
| Withdraw Report | Revokes the link; it stops answering on the next request. Returns `{ success: true, id }` whether or not a link was live, and after the incident has closed. |
| Get Timeline | Every append-only entry on the incident, oldest first, open or closed, one item per entry: `seq`, `at`, `kind`, `status`, `actor_user_id`, `data` (each kind's own facts, which may gain keys) and `incident_id`. Order and dedup on `seq`, not `at`. This is what a "here is what happened" post on resolve reads, and what "who was paged and when" reads later. Unpaginated. |
| Get Context | What the situational sources say **now** about the destination the subject stated **then** (frozen when the miss raised): the same briefing object as Check-In → Get Briefing, with `available: true`. `{ available: false, reason: 'no_destination' }` on an incident with no located destination, which is most of them. |

Get Search, Locate and Beacon need the subject's consent (`409 consent_missing`)
and an open incident (`409 incident_closed`). Photo URLs in `subject.profile`
are presigned and expire in minutes; every photograph carries `taken_at` and
`age_days`, and anything that shows the image should show its age.

**The report link is a credential.** Anyone holding the `url` that Share
Report and Get Report return can read the subject's photograph, description
and captured positions with no login. n8n keeps execution data, so a workflow
that handles it should send the link where it is needed (a text message, a
chat channel, an email to the search team) and not write it into logs or
sheets. The pattern that fits: on `incident.triggered` for a check-in incident,
Share Report and post the link; later, branch on Get Report's `view_count` to
chase a team that has not opened it; on `incident.resolved`, Withdraw Report.
A closed incident keeps answering the page with a stand-down notice until the
link is withdrawn or its seven days run out. The node can be used as an AI
agent tool; do not expose Share Report or Get Report that way, because the
link then lands in the model's context and transcript. These three
operations, like Get Search, Locate and Beacon, need a current access token;
the node signs in afresh before its cached token expires, so nothing extra is
required.

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
| Get Beacon Opt-In / Set Beacon Opt-In | Whether a searcher may light this responder's torch and sound their phone during an activation (Responder Incident: Beacon). Separate from location. Opting out expires every live command and puts out a burning beacon. |
| Get Images Opt-In / Set Images Opt-In | Whether photographs are stored. Opting out deletes every photograph, with no open-incident exception. The upload flow itself is not in the node. |
| Get Profile / Set Profile | The reusable vehicle description (make, model, colour, year, plate). A blank text field clears it; a year of 0 clears the year. Set is refused with `409 consent_missing` until the responder opts in. |
| Get Briefing | The pre-departure briefing for the check-in's stated destination: `destination`, `stated_at`, `assembled_at`, `radius_km`, `complete`, `lines` (one sentence per item), `items` (each with `kind`, `severity`, `headline`, `description`, `instruction`, `area`, timestamps, `url` and a `source` with `attribution` that must be shown alongside it) and `sources` (each with `state` and `answered`), plus `available: true`. `{ available: false, reason: 'no_destination' }` when the check-in has no located destination (no details consent, nothing typed, or a place named in words with no coordinates). Pairs with Arm as a scheduled step. |
| Set Details | Check-in ID plus wearing, origin, destination (text and/or coordinates) for one check-in. Blanks clear. Refused with `409 consent_missing` until the responder opts in; coordinates are dropped (returned `null`) unless location is also opted in. |

Arm, Extend, Satisfy and Cancel accept an optional **Location** (latitude,
longitude, accuracy, fix time) and an optional **Details** object with the same
fields as Set Details. The server stores either only if the responder has
opted in, never fails the transition over them, and never reports whether it
kept them. Read the check-in back to see what it holds.

**A briefing is not advice.** It reports what the sources say and when they
said it. Nothing in it says a trip is safe, and it is never a reason a
check-in was not armed or an escalation did not run. `severity` and the text
are the source's own words. "Nothing reported" and "the sources could not be
reached" are different answers: branch on `complete` and each source's
`answered` before telling anyone that all is quiet. A source that is down
never fails the request; it is reported inside `sources`.

### Source (admin, read-only)

| Operation | Notes |
|---|---|
| Get Many | Every source and what it escalates to: `escalates_to` is `{ type: 'schedule' \| 'escalation_policy', id }` or null (nothing, which pages every responder), with `escalation_schedule_id`, `escalation_policy_id`, `max_priority`, `default_local_grace_seconds`, `type`, and `integration_keys` as prefix, lane, `last_used_at` and `revoked_at`, never the key itself. |

Sources are edited on the Sources page. The `id` here is what Incident →
Create's **Source ID** takes with an `art_` token, and `last_used_at` on a
key is how a workflow spots a monitor that has gone quiet.

### Escalation Policy (admin, read-only)

| Operation | Notes |
|---|---|
| Get Many | Every ladder: `name`, `repeat_count` (how many times the whole list runs again after its last rung; 0 runs it once) and `rules` in position order, each with `ack_timeout_seconds` and `targets` (`user` or `schedule`). Nobody is resolved here. |
| Get | One ladder with `would_wake` on every rung: the people that rung would page right now, each with the `via` label the timeline records for a real page, or `unresolved` as `no_targets` (the rung names nobody) or `nobody` (its targets resolve to no-one today). Optional **At** answers for another instant. A live answer about the present, never a record; what a rung did wake is on the incident's timeline. |

A coverage audit is Source → Get Many joined to Escalation Policy → Get on
each `escalation_policy_id`: any source whose ladder's first rung reports
`unresolved` is one whose next incident pages nobody by name. Run it on a
schedule with **At** set to the next weekend night.

**Dropdowns.** Every Schedule ID field, on the Schedule resource itself and
on Layer, Override, Handoff and Check-In, is a dropdown filled from the
responder credential, and still takes an expression. Source ID on Incident → Create stays a plain
field: that resource runs on an integration key, which cannot list sources.

### Record

The incident record over a date range, for the manager's weekly "who did not
answer, and how fast did the rest answer" and the compliance folder's monthly
export. Admin role, and the API tier (Duty of Care). `From` and `To` are
dates, taken as whole days in UTC at both ends, so what a person looked at on
the records page and what a workflow fetched are the same period; both are
required, and a range longer than 366 days is refused. Incidents are counted
by when they were raised. These routes need a current access token.

| Operation | Notes |
|---|---|
| Get Incidents | Every incident raised in the range, newest first, one item each, including ones still open (`resolved_at: null`): `id`, `title`, `dedup_key`, `status` (`triggered` or `acknowledged` while open; `resolved`, `auto_resolved` or `expired` once closed, and `expired` is the finding), `priority`, `urgency`, `source_id`, `checkin_id`, `duress_subject_user_id`, `triggered_at`, `acknowledged_at`, `acknowledged_by_user_id` (null when nobody has acknowledged yet, and when a ticket system acknowledged over the Incident resource), `assigned_to_user_id`, `assigned_at`, `resolved_at`, `escalation_rule_position`, `escalation_repeat_count`. Return All follows the server's pages; otherwise Limit. |
| Get Coverage | The coverage report as one object: `incidents`, `acknowledged`, `unacknowledged`, `expired`, `ack_seconds_median`, `ack_seconds_worst`, `rostered_pages`, `unrostered_pages` and the `unrostered` moments (this system needed a responder and resolved to nobody), `checkins_satisfied` / `extended` / `cancelled` / `missed`, `compliance_rate` and `compliance_percent`. Every figure counts rows written at the time, never a replay of today's rota over past dates. A null is a specific answer, not zero: `compliance_rate: null` means no deadlines fell in the range. |
| Export | The raw rows as a file in the item's `data` binary property: `timeline_csv` (the incident timeline), `checkin_csv` (the check-in events) or `json` (both tables). Byte for byte the file the records page's download button produces, with the server's file name. The item's JSON carries `file_name`, `mime_type` and `bytes`. |

### Ack-latency report

Every station keeps only 24 hours of history, and a phone shows one incident
at a time; the question "who did not answer last month" is answered here. On
a Schedule Trigger (weekly), Record → Get Incidents with Return All for the
last seven days, then a Code node per item. Skip rows with `resolved_at`
null (still open). For the rest, `acknowledged_at - triggered_at` in seconds
is the ack latency, `status === 'expired'` means nobody answered,
`acknowledged_at` set with `acknowledged_by_user_id` null means a ticket
system acknowledged it over the Incident resource, and
`escalation_rule_position` is how far up the ladder it went. Append the rows
to a Google Sheet or post the Record → Get Coverage object to a channel as
the summary; `ack_seconds_median` and `unrostered_pages` are the two numbers
a manager reads first. For the compliance folder, Record → Export with
`timeline_csv` on a monthly schedule into a Google Drive or S3 node.

## AlertRoster Webhook Trigger node

AlertRoster sends signed webhooks when an incident changes, and this node
receives them: no polling, no responder login, and nothing missed between
polls. Use it wherever n8n has a public URL; the polling trigger below is the
fallback.

**Setup.** Add the node, activate the workflow, and copy its **Production**
URL. On AlertRoster's **Webhooks** page (admin, Duty of Care tier) create an
endpoint with that URL and, unless you want fewer, no event filter (an
endpoint subscribed to nothing receives every event, including kinds added
later). The signing secret is shown exactly once there: paste it into an
**AlertRoster Webhook Secret** credential. Then use **Send a test event** on
that page: the delivery log shows a 200 (the node answers `ignored: test`
and starts nothing), and a wrong secret shows as a refused 401 with the
reason in words. Lost secrets are rotated there, not recovered.

| Option | Meaning |
|---|---|
| Events | Which incident events start the workflow: Triggered, Acknowledged, Escalated, Reassigned, Silenced, Unsilenced, Updated, Resolved. Empty means every incident event, including kinds AlertRoster adds later. |
| Duress Only | Only incidents raised under duress. |
| Emit Test Events | Whether a "Send a test event" starts the workflow. Its incident is synthetic (nil UUID) and must not be acted on; leave off except while wiring things up. |

Each item is `{ event, incident, event_id, created_at, account_id,
delivery_attempt }`: the same `event` and `incident` the polling trigger
emits, so the two are interchangeable downstream. `incident` is the full
incident object rendered **at send time**: a retried `incident.triggered`
can arrive with `status: resolved`, and both are true, so treat each item as
an upsert keyed on `incident.id` and read history from Responder Incident →
Get Timeline rather than from the sequence of webhooks.

What the node does with each delivery, before anything runs:

- verifies `x-alertroster-signature` (`t=…,v1=…`, HMAC-SHA256 over the raw
  bytes with the secret) and rejects a signature more than five minutes from
  its clock; a failure answers 401, which AlertRoster records as `refused`
  and does not retry, so a rotated or mistyped secret is visible on the
  Webhooks page;
- answers 200 and starts nothing for an event kind it was not asked for, a
  `webhook.test`, an incident the Duress Only filter drops, or a retry of an
  event id it accepted in the last 24 hours (AlertRoster retries for about
  eleven hours on a timeout, with the same id);
- starts the workflow and answers 200 straight away for everything else.

The duplicate memory lives in the workflow's static data and is best effort:
a retry that lands while a long execution is still running, after n8n's
answer was lost in transit, can run twice, which is one more reason to
upsert on `incident.id`.

## AlertRoster Trigger node (polling)

The fallback for an n8n that cannot receive webhooks. It polls with the
Responder credential. Pick the events to watch:

| Event | Fires when |
|---|---|
| Incident Triggered | A new incident appears in the open list |
| Incident Acknowledged | An open incident moves to `acknowledged`, or a reassigned incident that was already acknowledged is claimed by its new holder (the live `escalate_at` clears) |
| Incident Escalated | The ack window ran out with nobody answering: `escalation_rule_position` or `escalation_repeat_count` moved (the next rung of an escalation policy fired and `paged_user_ids` names who it woke, or a schedule source paged again), or a local grace ended and `escalate_at` moved on past the window the node last saw |
| Incident Reassigned | `assigned_to_user_id` or `assigned_at` changed on an open incident before its ack window ran out, other than by the acknowledgement that claims it. Handing an incident back to the responder who already holds it counts. |
| Incident Silenced | `silenced_until` was set to a time still ahead; a second silence that overwrites a running one fires again |
| Incident Unsilenced | A silence ran out on a still-`triggered` incident with nobody having answered |
| Incident Resolved | An incident leaves the open list; the node fetches it by ID and reports its final status (`resolved`, `auto_resolved`, or `expired`) |

Each item is `{ event, incident }`. The events other than Triggered and
Resolved are read off the fields of the open list between two polls, so a
transition that happens and is undone inside one interval (a silence that
lapses, a reassignment that is acknowledged) is reported as whatever the
incident looks like at the next poll, and one poll can emit several events
for one incident (a reassignment and a silence together). Escalation versus
reassignment is decided by the clock: a moved ack window whose previous
deadline had already passed is an escalation, one moved before its deadline is
a reassignment. On first activation the node records what is already open and
emits nothing. A manual test run shows the current open incidents as Triggered
or Acknowledged samples, subject to the event selection, without changing
that state. Set the poll interval in the node; one request per poll plus one
per incident that closed.

**Duress.** Every incident carries `duress`, `true` when a check-in was
satisfied with the duress code: the person is signalling under coercion. The
incident is paged to the rest of the roster as any other, but it is withheld
from the subject's own devices and list, so a trigger running on the subject's
own responder credential never sees it. A workflow should branch on `duress`
before anything else (no call back to the subject). Turn on **Duress Only** to
make a trigger fire for those incidents alone.

Upgrading from a release before these events existed: the first poll after
the upgrade names only status transitions for incidents that were already
open, then carries the full snapshot from there.

## Recipes

### A desktop station as an n8n webhook

The AlertRoster desktop station keeps its local outputs (siren relays, screen
takeover, commands) on its own receiver service, and one of the output kinds
is `webhook`: the station POSTs JSON to a URL when an alert starts paging and
again when it stops. Pointing that at an n8n **Webhook** node makes n8n the
station's logic for anything beyond a relay, with no AlertRoster server
change, and it works whether the alert came down from the cloud or was raised
on the LAN. This is where a Slack post, a PLC call or a log line belongs.

1. In n8n add a Webhook node, method POST, and copy its URL (the production
   URL once the workflow is active).
2. On the station, Outputs → add an output of kind **Webhook** with that URL.
3. Branch on `{{ $json.body.state }}`: `fired` when an alert has started
   paging, `cleared` when it was acknowledged, resolved or expired. The same
   value arrives in the `X-AlertRoster-State` header.

The body is:

```json
{
  "event": "<output event name>",
  "state": "fired",
  "output": { "id": "…", "name": "Dispatch Slack" },
  "alert": {
    "id": "…", "status": "triggered", "urgency": "high",
    "title": "…", "detail": null, "dedup_key": null,
    "source": { … }, "triggered_at": "…", "ack_timeout_seconds": 300,
    "expires_at": "…", "acknowledged_at": null, "acknowledged_by": null,
    "resolved_at": null, "emergency": true, "available_actions": [ … ],
    "cloud": { "incident_id": "…", "status": "…", "assigned_to": "…", "duress": false, … }
  }
}
```

`alert` is the station's own alert object, not the cloud incident. When the
alert mirrors a cloud incident, `alert.cloud.incident_id` is the incident's
id, and a workflow that wants the authoritative record passes it to
**Responder Incident → Get** (or Get Search) on this node;
`alert.cloud` is `null` for an alert raised on the LAN that never reached the
cloud. The station retries a POST twice on a transport error or a 5xx, one
second apart, and does not retry a 4xx, so answer quickly (n8n's default
"respond immediately" is right) and do the work after responding.

The POST is not signed: anyone who can reach the URL can send one. Keep the
webhook on the LAN or behind a tunnel that only the station can use, and do
not have the workflow act on `fired` alone for anything that costs money or
wakes people; confirm against the cloud incident first. Signed POSTs are
tracked as alertroster-desktop #121.

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
