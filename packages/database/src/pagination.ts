/**
 * Shared pagination bounds for the list* store methods.
 *
 * Every `listByOwner` / `listByAgent` accepts an optional `offset`. The offset
 * is clamped here so a malformed or absurdly large value from a query string
 * cannot force an unbounded scan or an unnecessarily deep SQL OFFSET.
 */

/** Hard ceiling on a page offset. */
export const MAX_OFFSET = 10_000;

/** Hard ceiling on a page size. */
export const MAX_PAGE_LIMIT = 200;

/** Coerce an untrusted offset into a safe integer in [0, MAX_OFFSET]. */
export function clampOffset(offset: number | undefined | null): number {
  const n = Number(offset ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_OFFSET);
}

/** Coerce an untrusted limit into a safe integer in [1, max]. */
export function clampLimit(limit: number | undefined | null, max = MAX_PAGE_LIMIT, fallback = 50): number {
  const n = Number(limit ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * True when the requested offset is at or beyond the hard ceiling.
 *
 * The store clamps the offset down to MAX_OFFSET, so a client asking for
 * offset 10_050 would silently receive the offset-10_000 page again. Callers
 * must treat this as the end of the list (hasMore = false) so a "Load more"
 * button cannot loop forever appending the same records.
 */
export function isOffsetAtCeiling(offset: number | undefined | null): boolean {
  const n = Number(offset ?? 0);
  if (!Number.isFinite(n) || n <= 0) return false;
  return Math.floor(n) >= MAX_OFFSET;
}
