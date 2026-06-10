import { executeSQLQuery } from '../shared_helpers/sql.js';
import { Document } from '../types.js';

export function findFirstValidNegotiatorID(docs: Document[]): number | null {
    for (const doc of docs) {
        if (doc.negotiatorID !== undefined && doc.negotiatorID !== null) {
            return doc.negotiatorID;
        }
    }
    return null;
}

export async function getNegotiatorID(scarID: string): Promise<number | null> {
    const query = `SELECT Negotiator FROM Courtfiles WHERE VillageSCARIndexNumber = ? OR SCARIndexNumber = ?`;
    const params = [scarID, scarID];
    const res = await executeSQLQuery(query, params);

    if (res.length === 0) {
        console.warn(`No negotiator found for SCAR ID: ${scarID}`);
        return null;
    }

    return res[0]['Negotiator'] as number;
}
