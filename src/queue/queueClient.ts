/* eslint-disable @typescript-eslint/no-explicit-any */
import { executeSQLQuery } from '../shared_helpers/sql.js';
import { DocumentType } from '../types.js';

export interface QueueItem {
    ID: number;
    S3Bucket: string;
    S3Key: string;
    ParcelID: string;
    ScarID: string;
    Year: number;
    CountyCode: string;
    County: string;
    NegotiatorID: number | null;
    IsVillage: boolean;
    DocumentType: DocumentType;
    Identifier: string; // disposition code for stipulations, evidence type for evidence, NYSCEF doc-type code for misc
    Description: string | null; // NYSCEF document description; misc docs only — exhibit description (EXHIBIT) or Additional Document Information box (LETTER)
    ExhibitLabelMode: string | null; // 'NUMBER' | 'LETTER'; null = auto. Overrides exhibit label style.
    /**
     * `ExhibitLabel VARCHAR(8) NULL` and `ExhibitDocketSnapshot VARCHAR(255) NULL` — what we filed
     * this row as, and the docket we read to decide it. Written by `recordExhibitLabel`.
     *
     * Distinct from `ExhibitLabelMode`, which is only the requested *style*: the mode says "number
     * me", these say we filed as Exhibit 5 on a case that already showed `1, 2, 3, 4, 3 of 6`.
     *
     * Optional, not `| null` alone: like every column on this table these are a manual migration
     * (sql/2026-08-25_add_exhibit_label.sql), so before it is applied `SELECT *` returns rows with
     * the keys absent entirely — typing them as always-present would have TypeScript promise `null`
     * where the runtime hands back `undefined`.
     *
     * NULL/absent means "not an exhibit, or not recorded". It never means "not filed": the write is
     * best-effort, happens only for CONFIRMED and UNKNOWN verdicts, and no backfill is possible for
     * rows filed before the column existed.
     */
    ExhibitLabel?: string | null;
    ExhibitDocketSnapshot?: string | null;
    /**
     * `Court.NyscefUploadQueue.Status ENUM(...) NOT NULL DEFAULT 'QUEUED'` — manually managed, like
     * DocumentType, and not created by any repo, so this union is the definition of record. Writing a
     * value the column lacks fails with errno 1265 ("Data truncated").
     *
     * NEEDS_REVIEW (added 2026-08-19) exists because post-submit verification has three outcomes and
     * the third had no safe home: CONFIRMED -> UPLOADED, REJECTED -> FAILED (court refused it,
     * nothing filed, safe to retry), UNKNOWN -> NEEDS_REVIEW (submit was pressed, outcome unreadable,
     * MAY be on the docket). UNKNOWN cannot be FAILED: `claimQueueItem` and `getAllPendingItems` both
     * select `Status IN ('QUEUED','FAILED')` with no attempt filter, and `resetStuckProcessingItems`
     * pushes PROCESSING -> FAILED after 15 minutes, so anything reaching FAILED is re-filed
     * automatically — a duplicate court filing for a document the court may already hold.
     * NEEDS_REVIEW matches none of those queries, so it is terminal for every automated path and is
     * cleared only by a human who has checked the docket.
     *
     * Keep in sync wherever statuses are rendered or filtered, or NEEDS_REVIEW shows as unknown:
     * this union, and aventine-v2's ingest/queue status display.
     */
    Status: 'QUEUED' | 'PROCESSING' | 'UPLOADED' | 'FAILED' | 'SKIPPED' | 'NEEDS_REVIEW';
    Attempts: number;
    /**
     * `SubmittedAt DATETIME NULL` (added 2026-08-19). Stamped immediately *before* #btnSubmit is
     * clicked, so it answers the question a crash otherwise leaves open: a run that dies mid-filing
     * leaves its row in PROCESSING, and whether that row is safe to retry depends entirely on whether
     * the submit had already gone out. NULL means it had not (clean failure, retry it); non-NULL means
     * it had (may be on the docket, needs a human) — which is why `resetStuckProcessingItems` only
     * sweeps PROCESSING rows with `SubmittedAt IS NULL`.
     *
     * Rows predating the column are all NULL, which is correct: they are terminal already, and this is
     * only ever read for rows sitting in PROCESSING.
     */
    SubmittedAt: Date | null;
    ErrorMessage: string | null;
    IngestID: number | null;
    RealFrom: string | null;
    Testing: boolean;
    ForceUpload: boolean;
}

export async function getQueueItemById(id: number): Promise<QueueItem | null> {
    const rows = await executeSQLQuery(`SELECT * FROM Court.NyscefUploadQueue WHERE ID = ? AND Status IN ('QUEUED', 'FAILED') LIMIT 1`, [id]);
    if (!rows.length) return null;
    const row = rows[0];
    return {
        ...row,
        IsVillage: !!row.IsVillage,
        Testing: !!row.Testing,
        ForceUpload: !!row.ForceUpload,
    } as QueueItem;
}

export async function claimQueueItem(id: number): Promise<void> {
    // SubmittedAt is cleared on claim because it describes the attempt in flight, not the row's
    // history. Carrying a previous attempt's value forward would make the stuck-item sweep read a
    // fresh attempt that never reached submit as one that did.
    await executeSQLQuery(
        `UPDATE Court.NyscefUploadQueue SET Status = 'PROCESSING', Attempts = Attempts + 1, SubmittedAt = NULL, UpdatedAt = NOW() WHERE ID = ?`,
        [id]
    );
}

export async function markUploaded(id: number): Promise<void> {
    await executeSQLQuery(`UPDATE Court.NyscefUploadQueue SET Status = 'UPLOADED', UpdatedAt = NOW() WHERE ID = ?`, [id]);
}

export async function markFailed(id: number, errorMessage: string): Promise<void> {
    await executeSQLQuery(`UPDATE Court.NyscefUploadQueue SET Status = 'FAILED', ErrorMessage = ?, UpdatedAt = NOW() WHERE ID = ?`, [errorMessage, id]);
}

// Terminal-and-untouchable. claimQueueItem and getPendingItems both select only QUEUED/FAILED, so
// a NEEDS_REVIEW row is never re-claimed by the SQS worker, the pending sweep, or the stuck-item
// recovery. That is the whole point: this status means "submit was pressed and we could not tell
// whether the court took it", and the one thing that must not happen is an automatic re-file of a
// document that may already be on the docket. Clearing it is a human decision after checking NYSCEF.
export async function markNeedsReview(id: number, errorMessage: string): Promise<void> {
    await executeSQLQuery(`UPDATE Court.NyscefUploadQueue SET Status = 'NEEDS_REVIEW', ErrorMessage = ?, UpdatedAt = NOW() WHERE ID = ?`, [errorMessage, id]);
}

export async function markSkipped(id: number): Promise<void> {
    await executeSQLQuery(`UPDATE Court.NyscefUploadQueue SET Status = 'SKIPPED', UpdatedAt = NOW() WHERE ID = ?`, [id]);
}

// Stamped immediately before #btnSubmit is clicked. This is the only durable record that a filing
// left our side, and it exists so a crash between the click and the status write can be told apart
// from a crash before the click ever happened.
export async function markSubmitAttempted(id: number): Promise<void> {
    await executeSQLQuery(`UPDATE Court.NyscefUploadQueue SET SubmittedAt = NOW(), UpdatedAt = NOW() WHERE ID = ?`, [id]);
}

// Width of Court.NyscefUploadQueue.ExhibitDocketSnapshot.
const DOCKET_SNAPSHOT_MAX = 255;

/**
 * Fits a docket snapshot inside its column, saying so when it does not.
 *
 * A case with enough exhibits overruns VARCHAR(255), and under strict mode that is an error, not a
 * silent trim — which would throw away the whole record this column exists to keep (and quietly,
 * since the write is deliberately swallowed). Truncating here keeps the useful head of the list and
 * marks how much was dropped, so a short value is never mistaken for the complete docket.
 *
 * ASCII marker on purpose: this string is a DB value, and there is no reason to make it depend on
 * the column's charset.
 */
export function truncateDocketSnapshot(snapshot: string, max: number = DOCKET_SNAPSHOT_MAX): string {
    if (snapshot.length <= max) return snapshot;
    const keep = Math.max(0, max - 12); // 12 reserved for the marker
    // Final slice is the guarantee: whatever the marker's own length turns out to be, the result fits.
    return `${snapshot.slice(0, keep)}...+${snapshot.length - keep} more`.slice(0, max);
}

let warnedMissingExhibitColumns = false;

/**
 * Records the exhibit number/letter this row was filed under, and the docket we read to choose it.
 *
 * Best-effort by construction, and a write of its own rather than columns on `markUploaded`'s
 * UPDATE. Folding them in would mean an errno 1054 on a *successful* filing left the row in
 * PROCESSING, where `resetStuckProcessingItems` reads its non-null SubmittedAt and escalates a
 * filing that actually worked. This is metadata about a filing that has already happened; nothing
 * about recording it may change that filing's recorded outcome.
 *
 * Deliberately does not touch UpdatedAt. That column drives the 15-minute stuck-item threshold, and
 * a diagnostic write should not be able to push back when a genuinely stuck row is noticed.
 */
export async function recordExhibitLabel(id: number, exhibitLabel: string, docketSnapshot: string): Promise<void> {
    try {
        await executeSQLQuery(`UPDATE Court.NyscefUploadQueue SET ExhibitLabel = ?, ExhibitDocketSnapshot = ? WHERE ID = ?`, [
            exhibitLabel,
            truncateDocketSnapshot(docketSnapshot),
            id,
        ]);
    } catch (err) {
        // A missing column is a deployment-order fact, not a per-filing event: without this latch it
        // would warn on every exhibit we file until the migration lands, which is how a warning
        // becomes something people scroll past.
        const missingColumn = (err as { code?: string })?.code === 'ER_BAD_FIELD_ERROR';
        if (missingColumn && warnedMissingExhibitColumns) return;
        if (missingColumn) warnedMissingExhibitColumns = true;
        console.warn(
            `Could not record exhibit label '${exhibitLabel}' for queue item ID=${id} (non-fatal; the filing itself is unaffected).` +
                (missingColumn ? ' sql/2026-08-25_add_exhibit_label.sql has not been applied to this environment — further occurrences suppressed.' : ''),
            err
        );
    }
}

// Recovers rows abandoned in PROCESSING by a run that died mid-filing.
//
// This used to send every stuck row to FAILED, which is re-claimable — so a run that crashed
// *after* pressing submit got its document filed a second time. SubmittedAt splits the two cases,
// and the ordering matters: the NEEDS_REVIEW update runs first, so a row that has SubmittedAt set
// can never be caught by the FAILED sweep that follows.
export async function resetStuckProcessingItems(): Promise<{ needsReviewIDs: number[] }> {
    // Read the post-submit set first so the caller can raise an incident naming the exact rows.
    // Silently parking these would recreate the original problem in a new place: a document
    // possibly sitting on the docket with nothing telling anyone to go look.
    const rows = await executeSQLQuery(
        `SELECT ID FROM Court.NyscefUploadQueue
       WHERE Status = 'PROCESSING' AND SubmittedAt IS NOT NULL AND UpdatedAt < NOW() - INTERVAL 15 MINUTE`
    );
    const needsReviewIDs: number[] = rows.map((row: any) => row.ID);

    // Submit had already gone out — the court may hold this document. Terminal, never auto-retried.
    if (needsReviewIDs.length > 0) {
        await executeSQLQuery(
            `UPDATE Court.NyscefUploadQueue
           SET Status = 'NEEDS_REVIEW',
               ErrorMessage = 'Run died after the filing was submitted to NYSCEF; the document may be on the docket. Check before re-filing.',
               UpdatedAt = NOW()
           WHERE ID IN (${needsReviewIDs.map(() => '?').join(',')})`,
            needsReviewIDs
        );
    }

    // Never got as far as submitting — the court has nothing, so this is a clean retry.
    await executeSQLQuery(
        `UPDATE Court.NyscefUploadQueue
       SET Status = 'FAILED', ErrorMessage = 'Timed out in PROCESSING state'
       WHERE Status = 'PROCESSING' AND SubmittedAt IS NULL AND UpdatedAt < NOW() - INTERVAL 15 MINUTE`
    );

    return { needsReviewIDs };
}

// An item counts as "pending" until it reaches a TRULY terminal state. A FAILED item is
// only terminal once its retries are exhausted (Attempts >= maxAttempts); while it still
// has retries left it will be picked up again by retryFailedItems, so we keep it pending
// to defer the failure notification until the item can no longer be retried.
export async function countPendingItemsForIngest(ingestID: number, maxAttempts: number): Promise<number> {
    const rows = await executeSQLQuery(
        `SELECT COUNT(*) AS cnt FROM Court.NyscefUploadQueue
       WHERE IngestID = ?
         AND (
             Status IN ('QUEUED', 'PROCESSING')
             OR (Status = 'FAILED' AND Attempts < ?)
         )`,
        [ingestID, maxAttempts]
    );
    return Number(rows[0].cnt);
}

/**
 * Has the producing lambda finished handing this ingest over?
 *
 * `pending == 0` alone is not a completion signal. stipulation-ingest inserts one queue row at a
 * time inside its page loop, so an ingest whose first row is already uploaded may have forty more
 * still to be written — ingest 1506 completed its first item seven seconds *before* its last row was
 * inserted, and ingest 1445 gained a row 2h19m after its previous thirty had all finished. Acting on
 * "nothing pending" then closes and notifies a run that has barely begun.
 *
 * The producer's own status is the handoff flag: it writes UPLOADING once every page has been queued
 * (or a terminal status if it queued nothing), so anything still reading Received/Processing means
 * more rows may be coming.
 *
 * `staleAfterMinutes` is the escape hatch. A producer that dies mid-loop would otherwise pin the
 * ingest at Processing and suppress its notification forever, which is worse than the premature one.
 * LastAccessTimestamp is bumped by UpdateIngestItemStatus on every item, so it is a live heartbeat
 * while the producer is working.
 */
export async function isIngestHandedOff(ingestID: number, staleAfterMinutes: number): Promise<boolean> {
    const rows = (await executeSQLQuery(
        `SELECT Status, LastAccessTimestamp < NOW() - INTERVAL ? MINUTE AS IsStale
           FROM IngestTracking.Ingest WHERE IngestID = ?`,
        [staleAfterMinutes, ingestID]
    )) as Array<{ Status: string; IsStale: number | null }>;

    // No row: a queue item pointing at an ingest that does not exist. Nothing can ever move it, so
    // treat it as handed off rather than deferring on it forever.
    if (!rows.length) {
        console.warn(`IngestID=${ingestID}: no IngestTracking.Ingest row — treating as handed off (nothing can ever advance it).`);
        return true;
    }
    const { Status, IsStale } = rows[0];
    if (Status !== 'Received' && Status !== 'Processing') return true;
    // Say so loudly. Proceeding here means finalising a run whose producer never announced it had
    // finished queueing, so any "why did this notify early / short" question starts at this line.
    if (IsStale === 1) {
        console.warn(
            `IngestID=${ingestID}: still ${Status} but untouched for >${staleAfterMinutes}m — ` +
                `producer presumed dead, finalising without a handoff signal.`
        );
        return true;
    }
    return false;
}

/**
 * Per-status page counts from the ingest's own ledger.
 *
 * Used instead of the queue rows to decide Done vs Failed, because the queue only ever holds the
 * NYSCEF half of a run. Westchester pages are emailed to the clerk and BAR pages pushed to portal S3
 * — both finish inside the producer and never appear here — so judging by queue rows alone would
 * write Failed over a run whose other half succeeded. Ingest 1354 is that shape: 4 BAR + 21 SCAR.
 *
 * Returns an empty map for ingests that keep no item ledger (evidence and misc create none), which
 * is the caller's signal to fall back to queue-row counts.
 */
export async function getIngestItemCounts(ingestID: number): Promise<Map<string, number>> {
    const rows = (await executeSQLQuery(
        `SELECT ItemStatus, COUNT(*) AS n FROM IngestTracking.IngestItem WHERE IngestID = ? GROUP BY ItemStatus`,
        [ingestID]
    )) as Array<{ ItemStatus: string; n: number }>;
    return new Map(rows.map((r) => [r.ItemStatus, Number(r.n)]));
}

export async function getItemsForIngest(ingestID: number): Promise<QueueItem[]> {
    const rows = await executeSQLQuery(`SELECT * FROM Court.NyscefUploadQueue WHERE IngestID = ?`, [ingestID]);
    return rows.map((row: any) => ({
        ...row,
        IsVillage: !!row.IsVillage,
        Testing: !!row.Testing,
        ForceUpload: !!row.ForceUpload,
    })) as QueueItem[];
}

export async function getExhaustedItems(minAttempts: number): Promise<QueueItem[]> {
    const rows = await executeSQLQuery(`SELECT * FROM Court.NyscefUploadQueue WHERE Status = 'FAILED' AND Attempts >= ?`, [minAttempts]);
    return rows.map((row: any) => ({
        ...row,
        IsVillage: !!row.IsVillage,
        Testing: !!row.Testing,
        ForceUpload: !!row.ForceUpload,
    })) as QueueItem[];
}

// Returns every item that hasn't reached a terminal state, regardless of attempt count.
// Ordered by Attempts ASC so fresher items are processed before exhausted ones.
// claimQueueItem sets Status=PROCESSING immediately, so concurrent Lambda invocations
// (SQS path, EventBridge scheduler) will not pick up any item we have already claimed.
export async function getAllPendingItems(): Promise<QueueItem[]> {
    const rows = await executeSQLQuery(
        `SELECT * FROM Court.NyscefUploadQueue WHERE Status IN ('QUEUED', 'FAILED') ORDER BY Attempts ASC, ID ASC`,
        []
    );
    return rows.map((row: any) => ({
        ...row,
        IsVillage: !!row.IsVillage,
        Testing: !!row.Testing,
        ForceUpload: !!row.ForceUpload,
    })) as QueueItem[];
}

export async function getRetryItems(maxAttempts: number = 3): Promise<QueueItem[]> {
    const rows = await executeSQLQuery(
        `SELECT * FROM Court.NyscefUploadQueue
       WHERE (Status = 'FAILED' AND Attempts < ?)
          OR (Status = 'QUEUED' AND UpdatedAt < NOW() - INTERVAL 15 MINUTE)`,
        [maxAttempts]
    );
    return rows.map((row: any) => ({
        ...row,
        IsVillage: !!row.IsVillage,
        Testing: !!row.Testing,
        ForceUpload: !!row.ForceUpload,
    })) as QueueItem[];
}
