# n8n-nodes-alertroster — Design Spec (v0.1.0)

## Purpose

An n8n community node package for AlertRoster, the CloudBedrock call-out
notification and escalation platform. It lets n8n workflows raise and manage
incidents, read and edit on-call schedules, act on handoffs and overrides,
drive check-ins, and start workflows when incidents change state.

## Pattern Source

Mirrors `n8n-nodes-pewpros` (`/Users/jhankins/dev/n8n-nodes-pewpros`):
TypeScript to CommonJS, programmatic `INodeType`, `n8nNodesApiVersion: 1`,
`n8n-workflow ^1.82.0`, Node `>=20.15`, gulp icon copy, n8n eslint ruleset,
MIT, author CloudBedrock, zero runtime dependencies. Same `tsconfig.json`,
`gulpfile.js`, `.eslintrc.js`, `.prettierrc`, `.gitignore`.

Icon: `nodes/AlertRoster/alertroster.png`, the AlertRoster brand mark from
the backend's `priv/static/images/brand/alertroster-mark.png` at 128 px.

## The AlertRoster API in one paragraph

Everything is JSON under `https://alertroster.com` (dev tunnel:
`https://om.alertroster.com`). Every authenticated route takes
`Authorization: Bearer`. There are three credential families: source
integration keys `ark_async_…` (Lane A firehose, `POST /api/v2/enqueue`) and
`ark_sync_…` (Lane B, `/api/v2/incidents`), account tokens `art_…` (Lane B
only, console-minted, scoped, must name a `source_id`), and responder access
tokens (15 minute lifetime, from `POST /api/v1/auth/login` with email and
password, used on every `/api/v1/*` route). AlertRoster sends no outbound
webhooks, exposes no pagination or `updated_since` on any list, and returns
only open incidents from `GET /api/v1/incidents`. Contracts live in the
backend `docs/*_API.md` files; there is no OpenAPI document.

## Architecture

```
credentials/
  AlertRosterIntegrationKeyApi.credentials.ts   key + base URL (no test)
  AlertRosterResponderApi.credentials.ts        email + password + account id + base URL (test = login)
utils/
  AlertRosterHttp.ts        fetch wrapper, HTTPS enforcement, error decoding
  ResponderSession.ts       login, token cache in workflow static data, 401 re-login
  KeyClient.ts              bearer key wrapper with lane prefix check
nodes/AlertRoster/
  AlertRoster.node.ts       description + execute dispatch
  AlertRosterTrigger.node.ts polling trigger
  resources/
    shared.ts               ApiClient / ResourceModule types, helpers
    event.ts                Lane A
    incident.ts             Lane B
    responderIncident.ts    v1 incidents
    user.ts                 v1 users
    schedule.ts             v1 schedules
    layer.ts                v1 layers
    handoff.ts              v1 handoffs
    override.ts             v1 overrides
    checkin.ts              v1 check-ins
```

Each resource module exports its `INodeProperties[]` and an operation map.
`execute()` picks the module by `resource`, builds the right client from the
credential the resource declares, loops items, and returns paired results
with `continueOnFail` support.

### Credentials

`AlertRoster Integration Key` (`alertRosterIntegrationKeyApi`): `apiKey`,
`baseUrl`. The node checks the key prefix against the lane an operation
needs (Event needs `ark_async_`, Incident needs `ark_sync_` or `art_`) and
raises a descriptive error before calling the server, whose 401 is
deliberately uninformative.

`AlertRoster Responder` (`alertRosterResponderApi`): `email`, `password`,
optional `accountId`, `baseUrl`. `ResponderSession` signs in, caches the
access token plus account and user ids in global workflow static data
(key `alertroster:responder:<baseUrl>:<email>`), signs in again 60 s before
expiry or after any 401, and translates `account_choice_required` into an
error that lists the account ids. Refresh tokens are not used: AlertRoster
revokes the token family on refresh reuse, and concurrent executions sharing
one cache would trip that. A login every 15 minutes stays under the 20 per
15 minutes per IP throttle.

The action node declares both credentials with `displayOptions` on
`resource`, so the UI asks for exactly one.

### Resources and operations

Responses are unwrapped: `{"incident": {…}}` becomes the incident, list
wrappers become one item per element. Multi-key responses (schedule create
and delete) and flat responses are returned as-is. 204 responses return
`{ success: true, id }`.

| Resource | Credential | Operations |
|---|---|---|
| Event | key `ark_async_` | Trigger, Acknowledge, Resolve (dedup key; summary + severity on trigger; source, custom details JSON) |
| Incident | key `ark_sync_`/`art_` | Create (dedup key, title; urgency, priority, local grace seconds, source id), Get, Update (title, urgency, priority), Acknowledge, Resolve, Reassign (user id) |
| Responder Incident | responder | Get Many (open), Get, Acknowledge, Resolve, Reassign, Silence (fixed 90 s server-side) |
| User | responder | Get Many |
| Schedule | responder | Get Many, Get, Create (name, time zone, optional rotation), Update, Delete, Get On-Call (`at`), Get Roster (`from`, `to`) |
| Layer | responder, admin | Get Many, Create, Update, Delete, Set Members, Set Restrictions |
| Handoff | responder | Get Many (status), Create (schedule, to user, kind, window), Accept, Decline, Cancel |
| Override | responder, admin | Create (schedule, user, window), Cancel |
| Check-In | responder | Get Many, Create, Update, Delete, Arm, Extend, Satisfy, Cancel, Set Require Code, Get Code Status, Set Code, Clear Code, Clear Duress Code, Get Location Opt-In, Set Location Opt-In |

Integers are sent as JSON numbers (the server refuses strings). Timestamps
are passed through as ISO 8601 strings. Optional `location` on the four
check-in transitions is a collection of latitude, longitude, accuracy, fix
time.

Out of v0.1: devices, receivers, account deletion, Switchboard agent socket,
the WebSocket incident channel.

### Trigger — `AlertRoster Trigger` (polling, responder credential)

Events: Incident Triggered, Incident Acknowledged, Incident Resolved.

State (`getWorkflowStaticData('node')`): `known: { [id]: status }`.

Each poll fetches `GET /api/v1/incidents` (open only). An id not in `known`
emits Triggered (and Acknowledged too if it arrived already acknowledged).
An id whose status moved `triggered` to `acknowledged` emits Acknowledged.
An id in `known` but absent from the list is fetched by id; a terminal
status (`resolved`, `auto_resolved`, `expired`) emits Resolved with that
status in the payload; a 404 is dropped. Output items are
`{ event, incident }`. First activation seeds `known` and emits nothing.
Manual test runs return the current open incidents as Triggered samples
without touching state.

### Error handling

`AlertRosterHttp` throws `AlertRosterHttpError` with `status`, `code` (the
server's `error` string), and a message that includes 422 `details` and 403
`scope`. `execute()` wraps failures in `NodeApiError`, or emits
`{ error }` items under `continueOnFail`.

## Repo, Build and Publish

- GitHub: `github.com/CloudBedrock/n8n-nodes-alertroster` (public). The
  backend lives on CodeCommit and tracks issues via `/ci`; node package
  issues live on this GitHub repo.
- npm: `n8n-nodes-alertroster` 0.1.0, keyword `n8n-community-node-package`.
- Publish needs `npm login` first (session was expired at design time) and
  an OTP.

## Testing

1. `npm run build` and `npm run lint` clean.
2. Smoke test against `https://om.alertroster.com`: responder login,
   users list, open incidents; Lane B create → get → acknowledge → resolve
   with an `ark_sync_` key; Lane A enqueue with an `ark_async_` key.
3. Load in a local n8n, confirm both credentials render and the resource
   dropdown switches the credential requirement.

## Implementation tasks

1. Toolchain files, package.json, icon, credentials, HTTP + session utils.
2. Resource modules and the action node; build + lint.
3. Trigger node; build + lint.
4. README, spec, commit.
5. GitHub repo + push; npm publish after login.
6. Smoke test on the dev tunnel; fix and re-release if needed.
