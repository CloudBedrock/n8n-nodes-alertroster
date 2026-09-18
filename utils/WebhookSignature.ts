import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How AlertRoster signs an outbound incident webhook (backend
 * `docs/INCIDENT_WEBHOOKS.md` §5, `Alertroster.Webhooks.Signature`):
 * `x-alertroster-signature: t=<unix seconds>,v1=<hex>` where `v1` is
 * HMAC-SHA256 over `"<t>.<raw request body>"` with the endpoint's secret.
 * Stripe's scheme, deliberately.
 *
 * Pure: no n8n, no I/O, so the arithmetic can be exercised against a vector
 * produced by the sender rather than against a second copy of itself.
 */

export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureFailure = 'malformed' | 'stale' | 'mismatch';

export interface ParsedSignature {
  timestamp: number;
  digest: string;
}

export type SignatureVerdict =
  { ok: true; timestamp: number } | { ok: false; reason: SignatureFailure; detail: string };

/**
 * `t=<digits>,v1=<64 lower-case hex>`; parts split on the first `=` and
 * trimmed, as the sender's own parser does. Anything else is malformed.
 */
export function parseSignatureHeader(header: unknown): ParsedSignature | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 512) {
    return null;
  }
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const at = piece.indexOf('=');
    if (at <= 0) {
      continue;
    }
    parts.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim());
  }
  const rawTimestamp = parts.get('t');
  const digest = parts.get('v1');
  if (
    !rawTimestamp ||
    !digest ||
    !/^\d{1,12}$/.test(rawTimestamp) ||
    !/^[0-9a-f]{64}$/.test(digest)
  ) {
    return null;
  }
  return { timestamp: Number(rawTimestamp), digest };
}

/** The hex digest alone, over the exact bytes the sender put on the wire. */
export function sign(secret: string, timestamp: number, body: Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

/** The sender's header form, for tests and for anyone signing towards a receiver. */
export function signatureHeader(secret: string, timestamp: number, body: Buffer): string {
  return `t=${timestamp},v1=${sign(secret, timestamp, body)}`;
}

/**
 * Whether `header` is a signature over `body` with `secret`, made within
 * `toleranceSeconds` of now (either direction, as the sender's `verify/4`
 * checks it). Constant-time comparison: the one thing a verifier must not
 * do is leak how much of a forged digest was right. `detail` is written for
 * the admin reading the endpoint's delivery log and never carries a digest.
 */
export function verifySignature(
  secret: string,
  header: unknown,
  body: Buffer,
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): SignatureVerdict {
  if (header === undefined || header === null || header === '') {
    return {
      ok: false,
      reason: 'malformed',
      detail: 'missing x-alertroster-signature header',
    };
  }
  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    return {
      ok: false,
      reason: 'malformed',
      detail: 'x-alertroster-signature is not t=<unix seconds>,v1=<hex sha256>',
    };
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const skew = Math.abs(now - parsed.timestamp);
  if (skew > tolerance) {
    return {
      ok: false,
      reason: 'stale',
      detail: `signature timestamp is ${skew}s from this server's clock (tolerance ${tolerance}s)`,
    };
  }
  const expected = Buffer.from(sign(secret, parsed.timestamp, body), 'utf8');
  const received = Buffer.from(parsed.digest, 'utf8');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return {
      ok: false,
      reason: 'mismatch',
      detail: 'signature mismatch: the endpoint secret does not match this credential',
    };
  }
  return { ok: true, timestamp: parsed.timestamp };
}
