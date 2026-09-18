// Drives the compiled AlertRoster Webhook Trigger through a stub of n8n's
// IWebhookFunctions, signing bodies the way the server does. Run after
// `npm run build`: `npm run check:webhook`. No n8n process, no network.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { AlertRosterWebhookTrigger } = require('../dist/nodes/AlertRoster/AlertRosterWebhookTrigger.node.js');
const { signatureHeader, verifySignature, parseSignatureHeader } = require('../dist/utils/WebhookSignature.js');
const { rememberEventId, DEDUP_TTL_MS } = require('../dist/utils/WebhookDedup.js');

const SECRET = 'whsec_test_secret';
const NIL = '00000000-0000-0000-0000-000000000000';

function incident(overrides = {}) {
  return {
    id: '4c1f0000-0000-4000-8000-000000000001',
    status: 'triggered',
    priority: 'emergency',
    urgency: 'high',
    title: 'Database is down — again',
    duress: false,
    paged_user_ids: [],
    ...overrides,
  };
}

function eventBody(type, overrides = {}) {
  return {
    id: overrides.id ?? `evt-${type}-${Math.random().toString(36).slice(2)}`,
    type,
    created_at: '2026-09-17T18:05:02Z',
    account_id: '14a10000-0000-4000-8000-000000000002',
    incident: incident(overrides.incident),
  };
}

/** A delivery as the sender would make it: raw bytes plus a fresh signature. */
function delivery(body, { secret = SECRET, at = Math.floor(Date.now() / 1000), raw, attempt = 1 } = {}) {
  const bytes = raw ?? Buffer.from(JSON.stringify(body), 'utf8');
  return {
    rawBody: bytes,
    headers: {
      'content-type': 'application/json',
      'x-alertroster-event': body?.type,
      'x-alertroster-event-id': body?.id,
      'x-alertroster-delivery-attempt': String(attempt),
      'x-alertroster-signature': signatureHeader(secret, at, bytes),
    },
  };
}

/** Runs webhook() against a stubbed n8n context and reports what n8n would send. */
async function run(deliveryLike, { params = {}, state = {}, secret = SECRET, headers } = {}) {
  const node = new AlertRosterWebhookTrigger();
  const sent = { status: 200, body: undefined };
  const req = {
    rawBody: deliveryLike.rawBody,
    headers: headers ?? deliveryLike.headers,
    // n8n's reader fills the request it was called on; mirror that.
    readRawBody: deliveryLike.readRawBody
      ? async () => {
          await deliveryLike.readRawBody();
          req.rawBody = deliveryLike.rawBody;
        }
      : undefined,
  };
  const ctx = {
    getRequestObject: () => req,
    getResponseObject: () => ({
      status(code) {
        sent.status = code;
        return this;
      },
      json(payload) {
        sent.body = payload;
        return this;
      },
    }),
    getHeaderData: () => req.headers,
    getNodeParameter: (name, fallback) => (name in params ? params[name] : fallback),
    getCredentials: async () => ({ secret }),
    getWorkflowStaticData: () => state,
    getMode: () => 'trigger',
    getNode: () => ({ name: 'AlertRoster Webhook Trigger' }),
    helpers: { returnJsonArray: (rows) => rows.map((json) => ({ json })) },
  };
  const result = await node.webhook.call(ctx);
  const items = result.workflowData ? result.workflowData[0].map((i) => i.json) : null;
  return { result, items, sent, state };
}

test('golden vector from the Elixir signer', () => {
  const header = signatureHeader('s3cret', 1789012345, Buffer.from('{"a":1}', 'utf8'));
  assert.equal(header, 't=1789012345,v1=328112295ee2fa87c0da3e8bd10ad01868b29d8c1098139552ea85f77aede714');
  const verdict = verifySignature('s3cret', header, Buffer.from('{"a":1}', 'utf8'), { nowSeconds: 1789012345 });
  assert.equal(verdict.ok, true);
});

test('accepts a fresh, correctly signed incident event', async () => {
  const body = eventBody('incident.acknowledged');
  const { result, items, state } = await run(delivery(body, { attempt: 2 }));
  assert.equal(result.noWebhookResponse, undefined);
  assert.deepEqual(result.webhookResponse, { ok: true });
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0]), ['event', 'incident', 'event_id', 'created_at', 'account_id', 'delivery_attempt']);
  assert.equal(items[0].event, 'incident.acknowledged');
  assert.equal(items[0].event_id, body.id);
  assert.equal(items[0].delivery_attempt, 2);
  assert.equal(items[0].incident.title, body.incident.title);
  assert.equal(typeof state.seen[body.id], 'number');
});

test('rejects a stale signature in either direction', async () => {
  const body = eventBody('incident.triggered');
  const now = Math.floor(Date.now() / 1000);
  for (const at of [now - 600, now + 600]) {
    const { result, sent } = await run(delivery(body, { at }));
    assert.equal(result.noWebhookResponse, true);
    assert.equal(sent.status, 401);
    assert.match(sent.body.error, /from this server's clock/);
  }
});

test('rejects a tampered body, a wrong secret, and a missing secret', async () => {
  const body = eventBody('incident.triggered');
  const good = delivery(body);
  const tampered = { ...good, rawBody: Buffer.from(good.rawBody) };
  tampered.rawBody[tampered.rawBody.length - 3] ^= 0x01;
  let out = await run(tampered);
  assert.equal(out.sent.status, 401);
  assert.match(out.sent.body.error, /mismatch/);
  assert.doesNotMatch(out.sent.body.error, /[0-9a-f]{64}/);

  out = await run(delivery(body, { secret: 'other' }));
  assert.equal(out.sent.status, 401);

  out = await run(delivery(body), { secret: '' });
  assert.equal(out.sent.status, 401);
  assert.match(out.sent.body.error, /no signing secret/);
});

test('trims a secret pasted with a trailing newline', async () => {
  const body = eventBody('incident.triggered');
  const { items } = await run(delivery(body), { secret: `${SECRET}\n` });
  assert.equal(items.length, 1);
});

test('rejects malformed signature headers as 401', async () => {
  const body = eventBody('incident.triggered');
  const d = delivery(body);
  const digest = d.headers['x-alertroster-signature'].split('v1=')[1];
  const bad = [undefined, '', 'v1=' + digest, 't=abc,v1=' + digest, 't=123,v1=' + digest.slice(1), 't=123,v1=' + digest.toUpperCase()];
  for (const value of bad) {
    const headers = { ...d.headers };
    if (value === undefined) delete headers['x-alertroster-signature'];
    else headers['x-alertroster-signature'] = value;
    const { sent } = await run(d, { headers });
    assert.equal(sent.status, 401, `header ${JSON.stringify(value)}`);
  }
  assert.deepEqual(parseSignatureHeader(' t = 5 , v1 = ' + digest), { timestamp: 5, digest });
});

test('answers a retried event 200 without a run, and forgets it after the window', async () => {
  const body = eventBody('incident.resolved');
  const state = {};
  let out = await run(delivery(body), { state });
  assert.equal(out.items.length, 1);
  out = await run(delivery(body), { state });
  assert.equal(out.items, null);
  assert.deepEqual(out.result.webhookResponse, { ok: true, ignored: 'duplicate' });
  state.seen[body.id] = Date.now() - DEDUP_TTL_MS - 1000;
  out = await run(delivery(body), { state });
  assert.equal(out.items.length, 1);
});

test('dedup memory prunes by age and caps by count, and never mutates its input', () => {
  const now = 1_000_000_000_000;
  const seen = { old: now - DEDUP_TTL_MS - 1, fresh: now - 1000 };
  const a = rememberEventId(seen, 'new', now);
  assert.equal(a.duplicate, false);
  assert.deepEqual(Object.keys(a.seen).sort(), ['fresh', 'new']);
  assert.deepEqual(Object.keys(seen).sort(), ['fresh', 'old']);
  const big = {};
  for (let i = 0; i < 6000; i++) big[`e${i}`] = now - i;
  const b = rememberEventId(big, 'latest', now, DEDUP_TTL_MS, 5000);
  assert.equal(Object.keys(b.seen).length, 5000);
  assert.equal('latest' in b.seen, true);
  assert.equal('e5999' in b.seen, false);
});

test('filters by subscription, ignores unknown types, and accepts future incident kinds when unfiltered', async () => {
  let out = await run(delivery(eventBody('incident.resolved')), { params: { events: ['incident.triggered'] } });
  assert.deepEqual(out.result.webhookResponse, { ok: true, ignored: 'unsubscribed' });
  out = await run(delivery(eventBody('foo.bar')));
  assert.deepEqual(out.result.webhookResponse, { ok: true, ignored: 'unknown type' });
  out = await run(delivery(eventBody('incident.future')));
  assert.equal(out.items.length, 1);
  out = await run(delivery(eventBody('incident.updated')));
  assert.equal(out.items[0].event, 'incident.updated');
});

test('webhook.test is ignored unless asked for, and then bypasses the filters', async () => {
  const body = { ...eventBody('webhook.test'), incident: incident({ id: NIL, source_id: NIL, priority: 'normal', urgency: 'low' }) };
  let out = await run(delivery(body));
  assert.deepEqual(out.result.webhookResponse, { ok: true, ignored: 'test' });
  out = await run(delivery(body), { params: { emitTestEvents: true, events: ['incident.triggered'], duressOnly: true } });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].event, 'webhook.test');
  assert.equal(out.items[0].incident.id, NIL);
});

test('duress only keeps only duress incidents', async () => {
  let out = await run(delivery(eventBody('incident.triggered')), { params: { duressOnly: true } });
  assert.deepEqual(out.result.webhookResponse, { ok: true, ignored: 'filtered' });
  out = await run(delivery(eventBody('incident.triggered', { incident: { duress: true } })), { params: { duressOnly: true } });
  assert.equal(out.items.length, 1);
});

test('reads the raw body lazily, and refuses when it cannot', async () => {
  const body = eventBody('incident.triggered');
  const d = delivery(body);
  const lazy = { rawBody: undefined, headers: d.headers, readRawBody: undefined };
  lazy.readRawBody = async () => {
    lazy.rawBody = d.rawBody;
  };
  let out = await run(lazy);
  assert.equal(out.items.length, 1);

  out = await run({ rawBody: undefined, headers: d.headers, readRawBody: async () => { throw new Error('consumed'); } });
  assert.equal(out.sent.status, 400);

  out = await run({ rawBody: Buffer.alloc(0), headers: d.headers });
  assert.equal(out.sent.status, 400);
});

test('a valid signature over invalid JSON, or over JSON without id/type, is 400', async () => {
  let out = await run(delivery(null, { raw: Buffer.from('{not json', 'utf8') }));
  assert.equal(out.sent.status, 400);
  assert.match(out.sent.body.error, /valid JSON/);
  out = await run(delivery(null, { raw: Buffer.from('{"hello":"world"}', 'utf8') }));
  assert.equal(out.sent.status, 400);
  assert.match(out.sent.body.error, /id and type/);
});

test('non-ASCII bodies verify on bytes, not on a re-encoded string', async () => {
  const body = eventBody('incident.triggered', { incident: { title: 'Généra­teur — arrêté ✓' } });
  const { items } = await run(delivery(body));
  assert.equal(items[0].incident.title, body.incident.title);
});
