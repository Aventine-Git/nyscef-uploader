/* eslint-disable @typescript-eslint/no-explicit-any */
import { uploadToNyscef } from '../uploader.js';
import { emailSCARClerk } from '../emailer/emailSCARClerk.js';
import { notifyResults } from '../emailer/notifyResults.js';
import { handleWithdrawals } from '../helpers/withdrawals.js';
import { prepareFromQueueItem } from '../preparer/prepareFromQueueItem.js';
import { reportIncident } from '../shared_helpers/reporter.js';
import { recordUploadSuccess, recordUploadFailure } from '../helpers/uploadHealth.js';
import { enterCooldown, clearCooldown } from '../helpers/cfCooldown.js';
import { CloudflareBlockError, UnverifiedSubmissionError } from '../errors.js';
import { Document, DocumentType } from '../types.js';
import { updateIngestTrackingStatus } from '../shared_helpers/ingestTracking.js';
import { IngestStatus } from '../shared_helpers/types.js';
import {
    QueueItem,
    claimQueueItem,
    countPendingItemsForIngest,
    getExhaustedItems,
    getAllPendingItems,
    getIngestItemCounts,
    getItemsForIngest,
    getQueueItemById,
    getRetryItems,
    isIngestHandedOff,
    markNeedsReview,
    markFailed,
    markSkipped,
    markUploaded,
    resetStuckProcessingItems,
} from './queueClient.js';

const MAX_ATTEMPTS = 3;

// How long an ingest may sit in Received/Processing before we stop waiting for its producer to
// finish queueing. Matches the stuck-item sweep's own 15-minute threshold.
const HANDOFF_STALE_MINUTES = 15;

// Item statuses that mean the page got where it was going. SKIPPED counts: it means the document was
// already on the docket, which is an outcome, not a failure.
const SUCCESSFUL_ITEM_STATUSES = ['Uploaded', 'Skipped'];

// Sweeps rows abandoned in PROCESSING, and pages a human for the ones that had already been
// submitted to NYSCEF when the run died. Those are moved to NEEDS_REVIEW rather than FAILED so
// nothing re-files them, which means no later attempt will surface them either — this incident is
// the only notice anyone gets that a document may be on the docket with no record of it.
async function recoverStuckItems(): Promise<void> {
    const { needsReviewIDs } = await resetStuckProcessingItems();
    if (needsReviewIDs.length === 0) return;

    console.warn(`${needsReviewIDs.length} stuck item(s) were submitted before the run died — marked NEEDS_REVIEW: ${needsReviewIDs.join(', ')}`);
    await reportIncident(
        'nyscef-uploader',
        'stuck after submit',
        'critical',
        `${needsReviewIDs.length} filing(s) were submitted to NYSCEF but the run died before the outcome could be recorded.\n\n` +
            `Queue row ID(s): ${needsReviewIDs.join(', ')}\n\n` +
            `These are marked NEEDS_REVIEW and will NOT be retried automatically — re-filing blind would duplicate a real court filing. ` +
            `Check each case on NYSCEF: if the document is on the docket, mark the row UPLOADED; if not, set it back to QUEUED.`
    ).catch((e) => console.error('Failed to report stuck-after-submit incident:', e));
}

async function notifyIfIngestComplete(ingestID: number | undefined, testing: boolean): Promise<void> {
    if (!ingestID) return; // legacy items without an IngestID — direct.ts handles notification

    // The producer may still be queueing. Checked before the pending count because with one row
    // written so far and that row uploaded, "nothing pending" is true and completely wrong.
    if (!(await isIngestHandedOff(ingestID, HANDOFF_STALE_MINUTES))) {
        console.log(`IngestID=${ingestID}: producer has not finished handing off (still Received/Processing) — deferring.`);
        return;
    }

    // "Pending" includes FAILED items that still have retries left — so a failure
    // notification is only sent once the item is exhausted (Attempts >= MAX_ATTEMPTS) and
    // will no longer be retried, not on every intermediate failed attempt.
    const pending = await countPendingItemsForIngest(ingestID, MAX_ATTEMPTS);
    if (pending > 0) {
        console.log(`IngestID=${ingestID}: ${pending} item(s) still pending (incl. retryable failures) — deferring notification.`);
        return;
    }

    console.log(`IngestID=${ingestID}: all items terminal (uploaded/skipped/exhausted) — sending consolidated notification.`);
    const items = await getItemsForIngest(ingestID);
    const docs: Document[] = items.map((item) => ({
        type: item.DocumentType as DocumentType,
        scarID: item.ScarID,
        parcelID: item.ParcelID,
        year: item.Year,
        municode: item.ParcelID[3] === '0' && item.ParcelID[4] === '0' ? item.ParcelID.substring(0, 3) : item.ParcelID.substring(0, 5),
        county: item.County,
        negotiatorID: item.NegotiatorID,
        isVillage: item.IsVillage,
        docBuffer: Buffer.alloc(0), // not needed for notification
        identifier: item.Identifier,
        description: item.Description ?? null,
        s3Key: item.S3Key,
        exhibitLabelMode: null, // notification-only projection; nothing is filed from these Documents
        hasBeenUploaded: item.Status === 'UPLOADED' || item.Status === 'SKIPPED',
        wasSkipped: item.Status === 'SKIPPED',
        forceUpload: item.ForceUpload,
    }));

    const uploadedCount = docs.filter((d) => d.hasBeenUploaded && !d.wasSkipped).length;
    const skippedCount = docs.filter((d) => d.wasSkipped).length;
    const failedCount = items.filter((i) => i.Status === 'FAILED').length;
    const wasRetried = items.some((i) => i.Attempts > 1);
    const resultStr =
        [
            uploadedCount > 0 ? `${uploadedCount} Uploaded` : '',
            skippedCount > 0 ? `${skippedCount} Skipped (already uploaded)` : '',
            failedCount > 0 ? `${failedCount} Failed` : '',
        ]
            .filter(Boolean)
            .join(', ') || 'None processed';

    // Whoever asked for this ingest, so the notification reaches them rather than a shared channel.
    // Every row in an ingest is queued by the same caller, so the first one set speaks for all.
    const requestedBy = items.map((item) => item.RealFrom).find((from) => !!from) ?? '';

    await notifyResults(resultStr, docs, undefined, undefined, testing, failedCount > 0, wasRetried, requestedBy);

    // Batch clerk email — send once for all uploaded stips in this ingest
    const uploadedStipItems = items.filter((i) => i.Status === 'UPLOADED' && i.DocumentType === DocumentType.STIPULATION);
    if (uploadedStipItems.length > 0) {
        try {
            const realFrom = uploadedStipItems[0].RealFrom ?? '';
            const stipDocs = await Promise.all(uploadedStipItems.map(prepareFromQueueItem));
            const docsWithStatus = stipDocs.map((doc) => ({ ...doc, hasBeenUploaded: true }));
            await emailSCARClerk(docsWithStatus, realFrom, testing);
        } catch (clerkErr) {
            console.error('Failed to send batch clerk email:', clerkErr);
        }
    }

    // Close the ingest. This is the only place the queue path writes a terminal status — the
    // producers hand off at UPLOADING and stop, so without this every run that reached NYSCEF sat at
    // Processing indefinitely.
    //
    // Judged on the ingest's item ledger rather than the queue rows above: the queue holds only the
    // NYSCEF half of a run, so on a mixed batch (ingest 1354 was 4 BAR + 21 SCAR) a wholly-failed
    // queue would otherwise write Failed over four documents that did reach the portal. Evidence and
    // misc ingests keep no ledger, so those fall back to the queue counts.
    //
    // Last, and swallowed: a notification the team can act on matters more than the status column,
    // and this must not be able to suppress one.
    try {
        const itemCounts = await getIngestItemCounts(ingestID);
        const { status, summary } = resolveIngestOutcome(itemCounts, { uploadedCount, skippedCount, resultStr });
        await updateIngestTrackingStatus(ingestID, status, summary.substring(0, 450));
    } catch (statusErr) {
        console.error(`Failed to write terminal status for IngestID=${ingestID}:`, statusErr);
    }
}

/**
 * Decide a finished ingest's terminal status from its own ledger, falling back to the queue.
 *
 * Split out from `notifyIfIngestComplete` because the mixed-batch case is the whole point and is
 * otherwise unreachable to a test: the queue holds only the NYSCEF half of a run, so a batch of
 * 4 BAR + 21 SCAR pages (ingest 1354) whose 21 queued pages all failed still filed four documents to
 * the portal. Judging on queue counts alone would call that a total loss.
 *
 * `Failed` therefore means nothing in the run got anywhere — not merely that the queued part didn't.
 */
export function resolveIngestOutcome(
    itemCounts: Map<string, number>,
    queue: { uploadedCount: number; skippedCount: number; resultStr: string }
): { status: IngestStatus; summary: string } {
    // Evidence and misc ingests keep no item ledger, so an empty map means "no ledger", not "no work".
    if (itemCounts.size === 0) {
        const succeeded = queue.uploadedCount > 0 || queue.skippedCount > 0;
        return { status: succeeded ? IngestStatus.Done : IngestStatus.FAILED, summary: queue.resultStr };
    }
    const succeeded = SUCCESSFUL_ITEM_STATUSES.some((s) => (itemCounts.get(s) ?? 0) > 0);
    return {
        status: succeeded ? IngestStatus.Done : IngestStatus.FAILED,
        summary: [...itemCounts.entries()].map(([status, n]) => `${n} ${status}`).join(', '),
    };
}

async function processItem(item: QueueItem, notifyOnComplete = true): Promise<void> {
    await claimQueueItem(item.ID);

    const testing = item.Testing;
    const ingestID = item.IngestID ?? undefined;
    const realFrom = item.RealFrom ?? '';

    try {
        const doc = await prepareFromQueueItem(item);
        const output = await uploadToNyscef([doc], testing, ingestID, realFrom);
        if (output[0]?.wasSkipped) {
            console.log(`Queue item ID=${item.ID} already uploaded to NYSCEF — marking SKIPPED.`);
            await markSkipped(item.ID);
        } else {
            await markUploaded(item.ID);
        }
        recordUploadSuccess(); // upload pipeline is healthy — reset the failure streak
        clearCooldown(); // a success means Cloudflare is letting us through — lift any pause
        if (!ingestID) {
            // Legacy SQS items without an IngestID — email clerk immediately (no batching possible)
            await emailSCARClerk(output, realFrom, testing);
        }
        await handleWithdrawals(output, testing);
    } catch (error: any) {
        // An unverified submission is not a normal failure: the document may already be with the
        // court. FAILED is re-claimable (claimQueueItem selects QUEUED/FAILED, and the 15-minute
        // stuck-item sweep pushes PROCESSING into FAILED), so marking it FAILED would auto-refile
        // it and duplicate a real court filing. NEEDS_REVIEW is terminal for every automated path.
        const needsReview = error instanceof UnverifiedSubmissionError;
        try {
            if (needsReview) await markNeedsReview(item.ID, error.message);
            else await markFailed(item.ID, error.message);
        } catch (dbErr) {
            console.error('Failed to record item outcome:', dbErr);
        }
        // A Cloudflare block is the shared session's IP being throttled, not an item-specific
        // fault — pause all consumption so the rest of the queue doesn't stampede into the same
        // wall and burn attempts. The worker loops check isInCooldown() before processing.
        if (error instanceof CloudflareBlockError) {
            enterCooldown(`ParcelID ${item.ParcelID}: ${error.message}`);
        }
        // item.Attempts is the pre-claim value; claimQueueItem already incremented it by 1.
        // Only fire an incident once all retries are exhausted — transient failures
        // (Cloudflare blocks, network blips) should resolve on a later attempt without noise.
        // An unverified submission is always reported, regardless of attempt count — it is
        // terminal, nothing will retry it, and it needs a human on the docket today.
        if (item.Attempts + 1 < MAX_ATTEMPTS && !needsReview) {
            error.noReport = true;
        }
        // The worker has no handler wrapper to raise incidents, so track consecutive
        // failures here and page once when uploads are systemically broken.
        recordUploadFailure(`ParcelID ${item.ParcelID}: ${error.message}`);
        throw error;
    } finally {
        if (notifyOnComplete) {
            await notifyIfIngestComplete(ingestID, testing).catch((e) => {
                console.error('Error in notifyIfIngestComplete:', e);
                reportIncident(
                    'nyscef-uploader',
                    'notifyIfIngestComplete',
                    'major',
                    `Failed to send ingest notification for IngestID=${ingestID}: ${e?.message ?? String(e)}`
                ).catch((re) => console.error('Failed to report notification incident:', re));
            });
        }
    }
}

export async function processSQSRecords(records: any[]): Promise<void> {
    for (const record of records) {
        let id: number | undefined;
        try {
            const parsed = JSON.parse(record.body) as { id?: number };
            id = typeof parsed.id === 'number' ? parsed.id : undefined;
        } catch {
            console.error(`Unparseable SQS record body: ${record.body}`);
            continue;
        }
        if (!id) {
            console.error(`SQS record missing numeric id: ${record.body}`);
            continue;
        }
        const item = await getQueueItemById(id);
        if (!item) {
            console.log(`Queue item ID=${id} not found or not in QUEUED/FAILED state — skipping.`);
            continue;
        }
        console.log(`Processing queue item ID=${item.ID} ParcelID=${item.ParcelID}`);
        await processItem(item);
    }
}

export async function forceRetryExhaustedItems(): Promise<void> {
    await recoverStuckItems();
    const items = await getExhaustedItems(MAX_ATTEMPTS);
    if (items.length === 0) {
        console.log('No exhausted items to force-retry.');
        return;
    }
    console.log(`Force-retrying ${items.length} exhausted item(s).`);

    const ingestIDs = new Set<number>();
    const testingByIngest = new Map<number, boolean>();

    for (const item of items) {
        try {
            await processItem(item, false);
        } catch {
            // already marked FAILED inside processItem — continue to next
        }
        if (item.IngestID != null) {
            ingestIDs.add(item.IngestID);
            testingByIngest.set(item.IngestID, item.Testing);
        }
    }

    for (const ingestID of ingestIDs) {
        await notifyIfIngestComplete(ingestID, testingByIngest.get(ingestID) ?? false).catch((e) => {
            console.error(`Error notifying IngestID=${ingestID}:`, e);
            reportIncident(
                'nyscef-uploader',
                'notifyIfIngestComplete',
                'major',
                `Failed to send ingest notification for IngestID=${ingestID}: ${e?.message ?? String(e)}`
            ).catch((re) => console.error('Failed to report notification incident:', re));
        });
    }
}

export async function forceRetryAllItems(): Promise<void> {
    await recoverStuckItems();
    const items = await getAllPendingItems();
    if (items.length === 0) {
        console.log('No pending items to process.');
        return;
    }
    console.log(`Force-retrying all ${items.length} pending item(s) (QUEUED + FAILED, all attempt counts).`);

    const ingestIDs = new Set<number>();
    const testingByIngest = new Map<number, boolean>();

    for (const item of items) {
        try {
            await processItem(item, false);
        } catch {
            // already marked FAILED inside processItem — continue to next
        }
        if (item.IngestID != null) {
            ingestIDs.add(item.IngestID);
            testingByIngest.set(item.IngestID, item.Testing);
        }
    }

    for (const ingestID of ingestIDs) {
        await notifyIfIngestComplete(ingestID, testingByIngest.get(ingestID) ?? false).catch((e) => {
            console.error(`Error notifying IngestID=${ingestID}:`, e);
            reportIncident(
                'nyscef-uploader',
                'notifyIfIngestComplete',
                'major',
                `Failed to send ingest notification for IngestID=${ingestID}: ${e?.message ?? String(e)}`
            ).catch((re) => console.error('Failed to report notification incident:', re));
        });
    }
}

export async function retryFailedItems(): Promise<void> {
    await recoverStuckItems();
    const items = await getRetryItems(MAX_ATTEMPTS);
    if (items.length === 0) {
        console.log('No failed items eligible for retry.');
        return;
    }
    console.log(`Retrying ${items.length} failed item(s).`);

    // Suppress per-item notifications (notifyOnComplete=false) and instead collect unique
    // IngestIDs and notify once per ingest at the end — otherwise a multi-item ingest would
    // fire a notification after each item. The end-of-run notify still defers if any item is
    // a retryable failure (Attempts < MAX_ATTEMPTS); it only sends once all are terminal.
    const ingestIDs = new Set<number>();
    const testingByIngest = new Map<number, boolean>();

    for (const item of items) {
        try {
            await processItem(item, false);
        } catch {
            // already marked FAILED inside processItem — continue to next
        }
        if (item.IngestID != null) {
            ingestIDs.add(item.IngestID);
            testingByIngest.set(item.IngestID, item.Testing);
        }
    }

    // One consolidated notification per ingest
    for (const ingestID of ingestIDs) {
        await notifyIfIngestComplete(ingestID, testingByIngest.get(ingestID) ?? false).catch((e) => {
            console.error(`Error notifying IngestID=${ingestID}:`, e);
            reportIncident(
                'nyscef-uploader',
                'notifyIfIngestComplete',
                'major',
                `Failed to send ingest notification for IngestID=${ingestID}: ${e?.message ?? String(e)}`
            ).catch((re) => console.error('Failed to report notification incident:', re));
        });
    }
}
