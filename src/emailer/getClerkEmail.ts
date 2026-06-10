import { executeSQLQuery } from '../shared_helpers/sql.js';

export async function getClerkEmail(county: string): Promise<string | null> {
    if (!county || county.trim() === '') {
        console.warn('No county provided for clerk email lookup.');
        return null;
    }
    const query = `SELECT Email FROM Court.ScarClerks WHERE County = ?`;
    const params = [county.trim()];
    const res = await executeSQLQuery(query, params);
    if (res.length === 0) {
        console.warn(`No clerk email found for county: ${county}`);
        return null;
    }
    return res[0]['Email'] as string;
}
