import { reportIncident, reportStatus } from '../shared_helpers/reporter.js';

/**
 * Global Cloudflare cooldown for the long-running worker.
 *
 * A Cloudflare block is almost never per-item — it's the shared browser session's outbound
 * IP being rate-limited or served a managed challenge (see login.ts). When that happens the
 * fail-fast CloudflareBlockError (noRetry=true) stops the *in-process* retry loop, but it does
 * NOT stop the SQS poll loop or the 15-minute retry scheduler from feeding the NEXT queued item
 * straight into the same wall. Each such item burns one of its 3 attempts and, once three fail
 * in a row, trips the uploadHealth circuit breaker — so a ~1-minute rate-limit blip becomes a
 * false "systemically broken" page plus a handful of items pushed toward exhaustion (the June
 * incidents that reached Attempts 4-5 and needed a manual force-retry).
 *
 * This module lets the worker PAUSE all consumption for a cooldown window the moment a block is
 * seen. While paused, processItem is never called, so no item is claimed and no attempt is
 * consumed — the queue simply waits for Cloudflare's rate-limit window to clear. When the window
 * expires the worker probes with a single item; success clears the cooldown, another block
 * re-arms it.
 *
 * Paging policy — page only on a SUSTAINED outage, never a self-healing blip: the first arm
 * pauses quietly, and we alert only once a block survives a full cooldown window (arm #2), which
 * is exactly the transient-vs-real distinction the raw uploadHealth streak can't make. On
 * recovery we report healthy. Worker-only, mirroring uploadHealth: the Lambda/direct.ts path has
 * its own handlerWrapper.
 */
const WORKER_NAME = 'nyscef-uploader-worker';
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min — comfortably longer than a typical CF rate-limit window
const ALERT_AFTER_ARMS = 2; // page only once a block outlives one full cooldown window (arm #2)

// Epoch ms until which uploads are paused; 0 = not in cooldown.
let cooldownUntil = 0;
// Consecutive cooldown arms with no intervening success. A blip that clears on the post-cooldown
// probe never gets past arm #1; a sustained block keeps re-arming.
let arms = 0;
// True once we've paged for the current (sustained) episode — prevents re-paging every re-arm.
let reported = false;

export function cooldownMs(): number {
    const override = Number(process.env.CF_COOLDOWN_MS);
    return Number.isFinite(override) && override > 0 ? override : DEFAULT_COOLDOWN_MS;
}

export function isInCooldown(): boolean {
    return Date.now() < cooldownUntil;
}

export function cooldownRemainingMs(): number {
    return Math.max(0, cooldownUntil - Date.now());
}

/** Arm (or re-arm) the pause after a Cloudflare block. Stays quiet on the first arm (likely a
 *  transient blip); pages once the block survives a full cooldown window. */
export function enterCooldown(reason: string): void {
    cooldownUntil = Date.now() + cooldownMs();
    arms++;
    const secs = Math.round(cooldownMs() / 1000);
    console.warn(`[cf-cooldown] Cloudflare block (arm #${arms}) — pausing NYSCEF uploads for ${secs}s. ${reason}`);
    if (arms < ALERT_AFTER_ARMS || reported) return; // blip stays quiet; sustained outage pages once
    reported = true;
    const message = `Cloudflare block persisting beyond one ${secs}s cooldown — NYSCEF uploads paused. ${reason}`;
    reportStatus(WORKER_NAME, 'error', message).catch((e) => console.error('Failed to report cf-cooldown status:', e));
    reportIncident('nyscef-uploader', 'cloudflare-cooldown', 'major', message).catch((e) =>
        console.error('Failed to report cf-cooldown incident:', e)
    );
}

/** Lift the pause after a successful upload. Reports recovery only if we'd paged for this
 *  episode, so isolated blips never generate a healthy/error flap. Cheap no-op on the normal
 *  success path (called after every upload). */
export function clearCooldown(): void {
    const wasReported = reported;
    cooldownUntil = 0;
    arms = 0;
    reported = false;
    if (!wasReported) return;
    console.log('[cf-cooldown] Cloudflare cleared — resuming NYSCEF uploads.');
    reportStatus(WORKER_NAME, 'healthy', 'Cloudflare cooldown lifted — NYSCEF uploads resuming').catch((e) =>
        console.error('Failed to report cf-cooldown recovery:', e)
    );
}
