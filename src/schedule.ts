// Scheduling is derived from absolute epoch time rather than process start time,
// so restarts never shift when refreshes happen.

export const HOUR_MS = 60 * 60 * 1000;

/** Rolling cadence for refreshing security actions. */
export const REFRESH_PERIOD_MS = 23 * HOUR_MS;

/** Refresh slots land on the :30 mark. 23h is whole hours, so every slot does. */
const EPOCH_ANCHOR_MS = 30 * 60 * 1000;

/**
 * The 23h slot a timestamp falls into, counted from the epoch anchor — like
 * "days since epoch", but in 23h units so the slot rolls past midnight.
 */
export const refreshSlot = (now: number = Date.now()): number =>
    Math.floor((now - EPOCH_ANCHOR_MS) / REFRESH_PERIOD_MS);

/** Start of the next slot strictly after `now` — identical no matter when we restarted. */
export const nextRefreshTime = (now: number = Date.now()): number =>
    EPOCH_ANCHOR_MS + (refreshSlot(now) + 1) * REFRESH_PERIOD_MS;

/** A guild is due once its last refresh is a little under one full period old. */
export const DUE_CUTOFF_MS = REFRESH_PERIOD_MS - 30 * 60 * 1000;

/**
 * Discord `*_disabled_until`: 23h30m out, snapped down to a clean hour. Since
 * refreshes run on the :30 mark, this lands exactly on HH:00 with no minutes —
 * maximizing coverage while staying under Discord's 24h cap and leaving a
 * 30-minute buffer before the next refresh.
 */
const DISABLE_DURATION_MS = REFRESH_PERIOD_MS + 30 * 60 * 1000;

export function getDisableUntil(now: number = Date.now()): string {
    const target = new Date(now + DISABLE_DURATION_MS);
    target.setUTCMinutes(0, 0, 0);
    return target.toISOString();
}
