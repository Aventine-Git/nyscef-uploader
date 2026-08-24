import { executeSQLQuery } from './sql.js';
import { IngestItemStatus, IngestItemType, IngestStatus } from './types.js';

/**
 * Mirrors `updateIngestTrackingStatus` in _SHARED. Until this existed the uploader could move an
 * ingest's *items* but never the ingest itself, so every run that reached the NYSCEF queue sat at
 * Processing forever — the producers only ever wrote a terminal status on the paths that skip the
 * queue entirely (Westchester, BAR).
 *
 * The proc sets HasProblems on 'Failed' and otherwise preserves it, so a partial run written as
 * Done keeps the flag any failed item already raised.
 */
export async function updateIngestTrackingStatus(ingestId: number, status: IngestStatus, message: string | null = null) {
    const query = `CALL IngestTracking.UpdateIngestStatus(?, ?, ?)`;
    await executeSQLQuery(query, [ingestId, status, message]);
    console.log(`✅ [INGEST TRACKING] Updated ingest ID ${ingestId} with status: ${status}`);
}

export async function updateIngestItemStatus(ingestItemId: number, parcelId: string, itemType: IngestItemType, status: IngestItemStatus, message?: string) {
    const query = `CALL IngestTracking.UpdateIngestItemStatus(?, ?, ?, ?, ?)`;
    const params = [ingestItemId, parcelId, itemType, status, message || null];
    await executeSQLQuery(query, params);
    console.log(`✅ [INGEST ITEM] Updated IngestItem ID ${ingestItemId} for ParcelID ${parcelId} with status: ${status}${message ? ` and message: ${message}` : ''}`);
}
