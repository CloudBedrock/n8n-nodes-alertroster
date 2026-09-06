# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`n8n-nodes-alertroster`: an n8n community node package for AlertRoster (CloudBedrock's call-out / on-call / escalation platform). Two nodes ship: **AlertRoster** (action node, 9 resources) and **AlertRoster Trigger** (polling trigger). Zero runtime dependencies; HTTP is Node 20 `fetch`. Published to npm; public GitHub repo `CloudBedrock/n8n-nodes-alertroster` (issues for the node live there; the AlertRoster backend lives on CodeCommit).

Design spec: `docs/superpowers/specs/2026-09-06-n8n-nodes-alertroster-design.md`. The package deliberately mirrors the toolchain of `~/dev/n8n-nodes-pewpros`.

## Commands

```sh
npm run build      # rimraf dist && tsc && gulp build:icons && cp package.json dist/
npm run dev        # tsc --watch (does not copy icons)
npm run lint       # eslint over nodes/ credentials/ utils/ (n8n-nodes-base ruleset)
npm run lintfix
npm run format     # prettier --write over nodes/ credentials/ utils/
```

There is no test suite. Verification is `npm run build` + `npm run lint` clean, then a smoke test against a live AlertRoster instance (dev tunnel: `https://om.alertroster.com`) and a load into a local n8n:

```sh
npm run build && npm link
cd ~/.n8n/custom && npm link n8n-nodes-alertroster
```

`package.json` `n8n.nodes` / `n8n.credentials` point at `dist/` paths; adding a node or credential means adding its compiled path there too. `prepublishOnly` runs the build.

## Architecture

### Two credential families, chosen by resource

- `AlertRosterIntegrationKeyApi` (`alertRosterIntegrationKeyApi`): a bearer key + base URL. Keys are lane-bound: `ark_async_` for the Event resource (`POST /api/v2/enqueue`), `ark_sync_` or `art_` for the Incident resource (`/api/v2/incidents`). No `authenticate` block and no credential test on purpose: `utils/KeyClient.ts` checks the prefix against the lane before sending, because the server answers every key problem with an identical bare 401. `art_` tokens must supply a `source_id` on incident create (`KeyClient.isAccountToken`).
- `AlertRosterResponderApi` (`alertRosterResponderApi`): email + password (+ optional account id) for every `/api/v1/*` route and for the trigger. `utils/ResponderSession.ts` logs in, caches the 15-minute access token in **global** workflow static data under `alertroster:responder:<baseUrl>:<email>`, re-logs in 60 s before expiry or after any 401 (one retry). Refresh tokens are intentionally unused (server revokes the token family on reuse; concurrent executions share the cache). Login is throttled at 20 / 15 min / IP.

The action node declares both credentials with `displayOptions` on `resource`, derived from each module's `auth` field, so the UI asks for exactly one.

### Resource-module dispatch

`nodes/AlertRoster/AlertRoster.node.ts` holds no per-resource logic. Each file in `nodes/AlertRoster/resources/` exports a `ResourceModule` (`shared.ts`): `{ resource, auth: 'key' | 'responder', lane?, properties: INodeProperties[], operations: Record<op, handler> }`. The node concatenates every module's `properties` into its description and, in `execute()`, looks up the module by `resource`, builds one client (`KeyClient` or `ResponderSession`, both satisfy `ApiClient`) and calls `operations[operation]` per input item. Handlers are `function(this: IExecuteFunctions, itemIndex, client)` and return one object or an array (arrays fan out to one item each, all paired to the input item).

To add an operation: add its option to the module's `operation` property, add its parameters with `displayOptions: show(RESOURCE, [ops])`, add the handler. To add a resource: new module file, register it in the `RESOURCES` array and the `Resource` options list in the node.

Conventions enforced by helpers in `shared.ts` and by the server:
- Responses are unwrapped (`unwrap`/`unwrapList`): `{ incident: {…} }` becomes the incident; list wrappers become one item per element; multi-key responses (schedule create/delete) pass through; 204 becomes `{ success: true, id }`.
- Whole-number fields go through `integerParam`/`asInteger` because the server rejects strings and floats. Timestamps are passed through as ISO 8601 strings. Empty values are dropped with `compact`.
- `utils/AlertRosterHttp.ts` enforces HTTPS (plain HTTP only for loopback), 30 s timeout, and throws `AlertRosterHttpError { status, code, body }` where `code` is the server's `{"error": "…"}` string; 422 `details` and 403 `scope` are folded into the message. `execute()` rethrows as `NodeApiError` (or `NodeOperationError` if already one), or emits `{ error }` under `continueOnFail`.

### Trigger

AlertRoster has no outbound webhooks, no pagination, and `GET /api/v1/incidents` lists only open incidents. `AlertRosterTrigger.node.ts` therefore diffs the open list between polls using node-scoped static data `known: { [id]: status }`. New id → `incident.triggered` (plus `incident.acknowledged` if it arrived acknowledged); `triggered`→`acknowledged` → acknowledged; id gone from the list → fetch by id, emit `incident.resolved` with the terminal status (`resolved` / `auto_resolved` / `expired`), drop on 404. First activation seeds `known` and emits nothing; manual test runs return current open incidents without touching state.

### API reference

There is no OpenAPI document. Route contracts live in the AlertRoster backend's `docs/*_API.md` files. Out of scope for v0.1 (per spec): devices, receivers, account deletion, Switchboard agent socket, WebSocket incident channel.
