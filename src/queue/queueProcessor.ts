/* eslint-disable @typescript-eslint/no-explicit-any */
import { uploadToNyscef } from '../uploader.js';
import { emailSCARClerk } from '../emailer/emailSCARClerk.js';
import { notifyResults } from '../emailer/notifyResults.js';
import { handleWithdrawals } from '../helpers/withdrawals.js';
import { prepareFromQueueItem } from '../preparer/prepareFromQueueItem.js';
import { reportIncident } from '../shared_helpers/reporter.js';
import { recordUploadSuccess, recordUploadFailure } from '../helpers/uploadHealth.js';
import { Document, DocumentType } from '../types.js';
import {
    QueueItem,
    claimQueueItem,
    countPendingItemsForIngest,
    getExhaustedItems,
    getAllPendingItems,
    getItemsForIngest,
    getQueueItemById,
    getRetryItems,
    markFailed,
    markSkipped,
    markUploaded,
    resetStuckProcessingItems,
} from './queueClient.js';

const MAX_ATTEMPTS = 3;

async function notifyIfIngestComplete(ingestID: number | undefined, testing: boolean): Promise<void> {
    if (!ingestID) return; // legacy items without an IngestID — direct.ts handles notification

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

    await notifyResults(resultStr, docs, undefined, undefined, testing, failedCount > 0, wasRetried);

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
        if (!ingestID) {
            // Legacy SQS items without an IngestID — email clerk immediately (no batching possible)
            await emailSCARClerk(output, realFrom, testing);
        }
        await handleWithdrawals(output, testing);
    } catch (error: any) {
        try { await markFailed(item.ID, error.message); } catch (dbErr) {
            console.error('Failed to mark item as failed:', dbErr);
        }
        // item.Attempts is the pre-claim value; claimQueueItem already incremented it by 1.
        // Only fire an incident once all retries are exhausted — transient failures
        // (Cloudflare blocks, network blips) should resolve on a later attempt without noise.
        if (item.Attempts + 1 < MAX_ATTEMPTS) {
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
    await resetStuckProcessingItems();
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
    await resetStuckProcessingItems();
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
    await resetStuckProcessingItems();
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
