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
    Status: 'QUEUED' | 'PROCESSING' | 'UPLOADED' | 'FAILED' | 'SKIPPED' | 'NEEDS_REVIEW';
    Attempts: number;
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
