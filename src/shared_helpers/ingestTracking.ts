import { executeSQLQuery } from './sql.js';
import { IngestItemStatus, IngestItemType } from './types.js';

export async function updateIngestItemStatus(ingestItemId: number, parcelId: string, itemType: IngestItemType, status: IngestItemStatus, message?: string) {
    const query = `CALL IngestTracking.UpdateIngestItemStatus(?, ?, ?, ?, ?)`;
    const params = [ingestItemId, parcelId, itemType, status, message || null];
    await executeSQLQuery(query, params);
    console.log(`✅ [INGEST ITEM] Updated IngestItem ID ${ingestItemId} for ParcelID ${parcelId} with status: ${status}${message ? ` and message: ${message}` : ''}`);
}
