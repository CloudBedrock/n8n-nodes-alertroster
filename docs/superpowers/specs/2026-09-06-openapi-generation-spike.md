# Spike: generating resource descriptors from the AlertRoster OpenAPI spec

Tracker issue NNA-2 asked two independent things: a coverage check in CI
(done; `scripts/check-openapi-coverage.mjs`), and a spike on whether the
node's resource descriptors could be generated from the published spec
instead of hand-written. This is the spike. Measured against
`https://alertroster.com/api/docs/openapi.json` at API version 0.1.119 on
2026-09-06.

## What the spec carries

| Per operation | Count of 78 |
|---|---|
| `summary`, `description`, `tags`, `security` | 78 |
| Path or query `parameters` with a typed `schema` | 44 |
| `requestBody` with an `example` | 35 |
| `requestBody` with a field-level `schema` | **0** |
| Response `content` | 69 (all `example` only) |
| `components.schemas` | **0** |

Every request and response body schema is `{"type": "object",
"additionalProperties": true}`. The only place a field name, its type, or
whether it is required appears is a hand-written example, and an example
shows one valid shape, not the set of valid shapes. `extend` shows
`by_seconds` and `expected_deadline_at`; nothing marks the second one
optional, nothing says the first must be a positive integer, and nothing
mentions the optional `location` and `details` objects at all.

## What the descriptors need that the spec lacks

- Which fields are required and which are optional, per operation.
- Types the server enforces (integer vs float vs string; the node routes
  whole numbers through `asInteger` because the server refuses strings and
  floats).
- Conditional parameters: `time_zone` and `local_time` exist only when
  `kind` is `daily`; an `art_` token must send `source_id`.
- Semantics with no wire representation: the word `none` clearing an
  escalation schedule, blank-clears on the profile and details writes but
  compaction on the transitions, `0` meaning "untouched" for a location
  accuracy.
- Response unwrapping keys (`{ incident: … }`, `{ checkins: [ … ] }`,
  multi-key pass-throughs, 204 handling).
- Lane and key-prefix checks that happen client-side because the server
  answers every credential problem with the same bare 401.

A generator could emit `displayName`, `description`, the HTTP method and
URL, and the credential family. That is the least valuable fifth of a
descriptor, and the hand-tuning listed above would have to live in an
overlay the generator merges in, which is more machinery than the
descriptors themselves.

## Decision

Do not generate. Keep the descriptors hand-written and let the coverage
check turn drift into a red build. Revisit only if the server starts
emitting real JSON schemas (an `AlertrosterWeb.ApiSpec` change), at which
point the parameter lists, and possibly the required flags, become worth
generating; the semantics above would still need an overlay.
