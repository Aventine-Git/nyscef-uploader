import { executeSQLQuery } from '@shared/sql.js';

export async function determineIsVillage(scarID: string): Promise<boolean> {
    const query = `SELECT VillageSCARIndexNumber FROM Courtfiles WHERE VillageSCARIndexNumber = ?`;
    const params = [scarID];
    const res = await executeSQLQuery(query, params);
    return res.length > 0;
}
