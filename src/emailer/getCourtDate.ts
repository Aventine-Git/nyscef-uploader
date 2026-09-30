import { executeSQLQuery } from '../shared_helpers/sql.js';
import { Document } from '../types.js';

export default async function getCourtDate(document: Document): Promise<string | null> {
    // Keyed on parcel, because index numbers repeat across counties (EFSC2026-2 is both an L and a G
    // case). Year only breaks ties: motion letters are queued under the court date's year, not the case's.
    const query = `
        SELECT IFNULL(h.AdjournmentDate, h.CourtDate) AS HearingDate
        FROM aventinedb.Courtfiles cf
        LEFT JOIN Court.HearingDates h ON h.CourtDateID = IF(cf.SCARIndexNumber = ?, cf.CourtDateID, cf.VillageCourtDateID)
        WHERE cf.ParcelID = ? AND (cf.SCARIndexNumber = ? OR cf.VillageSCARIndexNumber = ?)
        ORDER BY cf.Year = ? DESC, cf.Year DESC
        LIMIT 1`;

    const { scarID, parcelID, year } = document;
    const result = await executeSQLQuery(query, [scarID, parcelID, scarID, scarID, year]);
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
