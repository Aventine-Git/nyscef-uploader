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
    const row = (result as { HearingDate: string | Date | null }[])?.[0];
    if (!row?.HearingDate) return null;

    // mysql2 hands back DATE columns as Date objects, but a 'YYYY-MM-DD' string can arrive instead
    // (driver config, or IFNULL coercing the two source columns). Never round-trip such a string
    // through `new Date()`: it is parsed as UTC midnight and then read back in local time, which
    // renders as the PREVIOUS day everywhere in the US. Read the parts off the string directly.
    if (typeof row.HearingDate === 'string') {
        const parts = row.HearingDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (parts) return `${parts[2]}-${parts[3]}-${parts[1]}`;
    }

    const date = new Date(row.HearingDate);
    if (Number.isNaN(date.getTime())) return null;
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${mm}-${dd}-${yyyy}`;
}
