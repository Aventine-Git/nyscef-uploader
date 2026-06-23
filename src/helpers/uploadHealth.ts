import { reportIncident, reportStatus } from '../shared_helpers/reporter.js';

/**
 * Circuit-breaker for systemic upload outages.
 *
 * The long-running worker has no handler wrapper (unlike the Lambda/direct.ts path,
 * which gets incident reporting for free via handlerWrapper). As a result, upload
 * failures in the worker were only ever console.error'd — a 100% failure run produced
 * total silence, since the one notification path (notifyResults) defers while any item
 * still has retries pending.
 *
 * This tracks consecutive upload failures across ALL worker entry points (SQS poll loop
 * and the retry/force-retry scheduler, which both funnel through processItem) and pages
 * exactly once when uploads are clearly broken, then stays quiet until a success — at
 * which point it reports recovery. The streak resets on any success, so isolated
 * transient blips (a one-off Cloudflare block) never trip it.
 */
const WORKER_NAME = 'nyscef-uploader-worker';
const FAILURE_ALERT_THRESHOLD = 3; // consecutive failures before paging; tune as needed

let consecutiveFailures = 0;
let alerted = false;

/** Call after an item uploads or is skipped successfully. Resets the streak and flips
 *  status back to healthy if we'd previously paged. */
export function recordUploadSuccess(): void {
    consecutiveFailures = 0;
    if (alerted) {
        alerted = false;
        reportStatus(WORKER_NAME, 'healthy', 'NYSCEF uploads recovered — succeeding again').catch((e) =>
            console.error('Failed to report upload recovery:', e)
        );
    }
}

/** Call on any item upload failure. Pages exactly once when the streak crosses the
 *  threshold; stays silent on further failures until a success resets it. */
export function recordUploadFailure(context: string): void {
    consecutiveFailures++;
    if (consecutiveFailures < FAILURE_ALERT_THRESHOLD || alerted) return;
    alerted = true;
    const message = `${consecutiveFailures} consecutive NYSCEF upload failures — uploads appear systemically broken. Latest: ${context}`;
    reportIncident('nyscef-uploader', 'worker-upload', 'critical', message).catch((e) =>
        console.error('Failed to report upload-failure incident:', e)
    );
    reportStatus(WORKER_NAME, 'error', message).catch((e) =>
        console.error('Failed to report unhealthy status:', e)
    );
}
