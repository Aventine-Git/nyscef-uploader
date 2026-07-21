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
    Status: 'QUEUED' | 'PROCESSING' | 'UPLOADED' | 'FAILED' | 'SKIPPED';
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
    await executeSQLQuery(`UPDATE Court.NyscefUploadQueue SET Status = 'PROCESSING', Attempts = Attempts + 1, UpdatedAt = NOW() WHERE ID = ?`, [id]);
}

export async function markUploaded(id: number): Promise<void> {
    await executeSQLQuery(`UPDATE Court.NyscefUploadQueue SET Status = 'UPLOADED', UpdatedAt = NOW() WHERE ID = ?`, [id]);
}

export async function markFailed(id: number, errorMessage: string): Promise<void> {
    await executeSQLQuery(`UPDATE Court.NyscefUploadQueue SET Status = 'FAILED', ErrorMessage = ?, UpdatedAt = NOW() WHERE ID = ?`, [errorMessage, id]);
}

export async function markSkipped(id: number): Promise<void> {
    await executeSQLQuery(`UPDATE Court.NyscefUploadQueue SET Status = 'SKIPPED', UpdatedAt = NOW() WHERE ID = ?`, [id]);
}

export async function resetStuckProcessingItems(): Promise<void> {
    await executeSQLQuery(
        `UPDATE Court.NyscefUploadQueue
       SET Status = 'FAILED', ErrorMessage = 'Timed out in PROCESSING state'
       WHERE Status = 'PROCESSING' AND UpdatedAt < NOW() - INTERVAL 15 MINUTE`
    );
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
