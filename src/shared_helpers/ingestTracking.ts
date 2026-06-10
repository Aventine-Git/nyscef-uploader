import { executeSQLQuery } from './sql.js';
import { IngestStatus, IngestItemStatus, IngestType, IngestItemType } from './types.js';

// insert into IngestTracking table
export async function createIngestTrackingRecord(
    messageId: string,
    realFrom: string,
    type: IngestType,
    inReplyToHeader: string | undefined,
    logStreamName: string,
    awsRequestId: string,
    testing: boolean
) {
    const query = `CALL IngestTracking.CreateIngest(?, ?, ?, ?, ?, ?, ?)`;
    const params = [messageId, realFrom, type.toString(), inReplyToHeader ? inReplyToHeader : null, logStreamName, awsRequestId, testing ? 1 : 0];
    const ingestTrackingRes = await executeSQLQuery(query, params);

    const ingestId: number | undefined = ingestTrackingRes[0]?.[0]?.IngestID as number;
    console.log('✅ [INGEST TRACKING] Logged ingest attempt in IngestTracking table.', { ingestId });
    return ingestId;
}

// update IngestTracking record with status
export async function updateIngestTrackingStatus(ingestId: number, status: IngestStatus, message: string | null = null) {
    const query = `CALL IngestTracking.UpdateIngestStatus(?, ?, ?)`;
    const params = [ingestId, status, message];
    const res = await executeSQLQuery(query, params);
    console.log(`✅ [INGEST TRACKING] Updated ingest ID ${ingestId} with status: ${status}`);
}

// update upload details
export async function updateIngestUploading(ingestId: number, uploadLogStreamName: string, uploadLogRequestId: string) {
    const query = `CALL IngestTracking.SetIngestUploading(?, ?, ?)`;
    const params = [ingestId, uploadLogStreamName, uploadLogRequestId];
    const res = await executeSQLQuery(query, params);
    console.log(`✅ [INGEST TRACKING] Updated ingest ID ${ingestId} with upload details.`);
}

// insert new item into IngestItem table
export async function createIngestItem(ingestId: number, parcelId: string, itemType: IngestItemType) {
    const query = `CALL IngestTracking.CreateIngestItem(?, ?, ?)`;
    const params = [ingestId, parcelId, itemType];
    try {
        const res = await executeSQLQuery(query, params);
        console.log(`✅ [INGEST ITEM] Created IngestItem for IngestID ${ingestId} and ParcelID ${parcelId} with itemType: ${itemType}.`);
    } catch (error: any) {
        if (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062) {
            console.warn(`⚠️ [INGEST ITEM] Duplicate IngestItem for IngestID ${ingestId}, ParcelID ${parcelId}, type ${itemType} — skipping.`);
            return;
        }
        throw error;
    }
}

// update IngestItem with status and optional message
export async function updateIngestItemStatus(ingestItemId: number, parcelId: string, itemType: IngestItemType, status: IngestItemStatus, message?: string) {
    const query = `CALL IngestTracking.UpdateIngestItemStatus(?, ?, ?, ?, ?)`;
    const params = [ingestItemId, parcelId, itemType, status, message || null];
    const res = await executeSQLQuery(query, params);
    console.log(`✅ [INGEST ITEM] Updated IngestItem ID ${ingestItemId} for ParcelID ${parcelId} with status: ${status}${message ? ` and message: ${message}` : ''}`);
}

// update Ingest user
export async function updateIngestUser(ingestId: number, userId: number) {
    const query = `CALL IngestTracking.UpdateIngestUser(?, ?)`;
    const params = [ingestId, userId];
    const res = await executeSQLQuery(query, params);
    console.log(`✅ [INGEST TRACKING] Updated ingest ID ${ingestId} with user ID: ${userId}`);
}

// update Ingest with warning message and mark as problematic
export async function markIngestProblematic(ingestId: number, warningMessage: string) {
    const query = `UPDATE IngestTracking.Ingest SET HasProblems = 1, Message = ? WHERE IngestID = ?`;
    const params = [warningMessage, ingestId];
    const res = await executeSQLQuery(query, params);
    console.log(`⚠️ [INGEST TRACKING] Marked ingest ID ${ingestId} as problematic with message: ${warningMessage}`);
}
