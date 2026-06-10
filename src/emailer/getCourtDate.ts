import { executeSQLQuery } from '../shared_helpers/sql.js';
import { Document } from '../types.js';

export default async function getCourtDate(document: Document): Promise<string | null> {
    const query = `
        SELECT IFNULL(h.AdjournmentDate, h.CourtDate) AS HearingDate
        FROM aventinedb.Courtfiles cf
        LEFT JOIN Court.HearingDates h ON cf.CourtDateID = h.CourtDateID
        WHERE cf.SCARIndexNumber = ? AND cf.Year = ?
        LIMIT 1`;

    const result = await executeSQLQuery(query, [document.scarID, document.year]);
    const row = (result as { HearingDate: string | null }[])?.[0];
    if (!row?.HearingDate) return null;
    const date = new Date(row.HearingDate);
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${mm}-${dd}-${yyyy}`;
}
