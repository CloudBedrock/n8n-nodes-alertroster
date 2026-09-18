/**
 * Event-id memory for the webhook trigger. AlertRoster mints one event id
 * per event per endpoint and keeps it on every retry, and it retries for
 * about eleven hours (12 attempts under `attempt^4 + 15` seconds of
 * backoff), each attempt freshly signed. The five-minute signature
 * tolerance therefore bounds a third party replaying a captured request,
 * not a legitimate retry: ids have to be remembered across the whole retry
 * horizon, and 24 hours covers it with room for jitter and queue delay.
 * The cap bounds the static-data row for an account that never stops.
 */

export const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
export const DEDUP_MAX_IDS = 5000;

export type SeenIds = Record<string, number>;

/**
 * Whether `id` was accepted within `ttlMs`, and the memory to store back:
 * a new object (n8n's static data notices assignment, not mutation) holding
 * every id still inside the window plus this one, trimmed to the newest
 * `max` when an account outruns the cap.
 */
export function rememberEventId(
  seen: SeenIds | undefined,
  id: string,
  nowMs: number,
  ttlMs = DEDUP_TTL_MS,
  max = DEDUP_MAX_IDS,
): { duplicate: boolean; seen: SeenIds } {
  const previous = seen ?? {};
  const acceptedAt = previous[id];
  const duplicate = typeof acceptedAt === 'number' && nowMs - acceptedAt <= ttlMs;

  const kept = Object.entries(previous).filter(
    ([key, at]) => key !== id && typeof at === 'number' && nowMs - at <= ttlMs,
  );
  kept.push([id, duplicate ? acceptedAt : nowMs]);
  kept.sort((a, b) => b[1] - a[1]);

  return { duplicate, seen: Object.fromEntries(kept.slice(0, max)) };
}
