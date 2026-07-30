import { executeSQLQuery } from '../shared_helpers/sql.js';
import { Document, DocumentType, isArbitraryMiscDoc } from '../types.js';

/**
 * `StipTracking.Status` values that mean the stip is already on file with the court.
 *
 * `SoOrdered` is *forward* of `NyscefUploaded`, not an alternative to it — the only writer of
 * SoOrdered (pdfOcr/invoicing/emailCheck.py, driven by NYSCEF's "STIPULATION - SO ORDERED"
 * notification) updates `WHERE Status = 'NyscefUploaded'`, so a case can only reach it by having
 * been filed first. Testing equality against `NyscefUploaded` alone therefore stopped recognising a
 * stip the moment the court so-ordered it, which is the state where re-filing is most obviously
 * wrong. Any status added after `SoOrdered` in the lifecycle belongs in this list too.
 */
export const FILED_STIP_STATUSES: readonly string[] = ['NyscefUploaded', 'SoOrdered'];

/**
 * Has a stip for this parcel/year already been filed, per the upload queue?
 *
 * Consulted in addition to `StipTracking.Status` because that column is not a durable record of
 * what was filed. stipulation-ingest calls `setCountersign` on every batch it accepts, resetting
 * Status to 'Countersigned' *before* it queues anything — so on a re-sent batch the evidence of the
 * earlier filing is gone by the time this guard runs, and the status check alone can only ever
 * catch a re-send that overlaps the original upload in time. Court.NyscefUploadQueue is
 * append-only: nothing rewrites a row once it reaches UPLOADED.
 *
 * The row being processed right now cannot match itself — it only becomes UPLOADED after a
 * successful filing, and it is QUEUED or PROCESSING at this point. Testing rows are excluded
 * because they never reach the portal, so they must not block a real filing.
 */
async function hasFiledStipulation(parcelID: string, year: number): Promise<boolean> {
    const rows = (await executeSQLQuery(
        `SELECT ID FROM Court.NyscefUploadQueue
          WHERE ParcelID = ? AND Year = ? AND DocumentType = 'STIPULATION' AND Status = 'UPLOADED' AND Testing = 0
          LIMIT 1`,
        [parcelID, year]
    )) as Array<{ ID: number }> | undefined;
    return !!rows && rows.length > 0;
}

export async function checkAlreadyUploaded(doc: Document, realFrom: string): Promise<boolean> {
    console.log(`Checking if document has already been uploaded for ParcelID: ${doc.parcelID}, Year: ${doc.year}`);
    if (realFrom.toLowerCase().includes('propriety')) {
        console.log('RealFrom indicates Propriety — skipping already uploaded check to allow re-uploads from Propriety.');
        return false;
    }

    if (doc.type === DocumentType.STIPULATION) {
        const checkQuery = `SELECT Status FROM StipTracking WHERE ParcelID = ? AND Year = ?`;
        const result = (await executeSQLQuery(checkQuery, [doc.parcelID, doc.year])) as Array<{ Status: string }>;
        // `.some`, not `result[0]`: StipTracking is keyed (ParcelID, Year, Stage, CaseType) and this
        // lookup supplies only half that key, so which row came back first was arbitrary.
        if (result && result.some((r) => FILED_STIP_STATUSES.includes(r.Status))) {
            console.log(`⏭️ Skipping ParcelID: ${doc.parcelID} - Stipulation already uploaded`);
            return true;
        }
        if (await hasFiledStipulation(doc.parcelID, doc.year)) {
            console.log(`⏭️ Skipping ParcelID: ${doc.parcelID} - Stipulation already filed (NyscefUploadQueue has an UPLOADED row for this parcel/year)`);
            return true;
        }
    } else if (doc.type === DocumentType.EVIDENCE) {
        const checkQuery = `SELECT Evidence FROM Court.UploadedEvidence WHERE ParcelID = ? AND Year = ?`;
        const result = (await executeSQLQuery(checkQuery, [doc.parcelID, doc.year])) as Array<{ Evidence: string }>;
        if (result && result.length > 0) {
            const raw = result[0].Evidence;
            let evidence: string[];
            if (Array.isArray(raw)) {
                evidence = raw;
            } else if (typeof raw === 'string') {
                try {
                    const parsed = JSON.parse(raw);
                    evidence = Array.isArray(parsed) ? parsed : [parsed];
                } catch {
                    evidence = [raw];
                }
            } else {
                evidence = [];
            }
            const capitalizedIdentifier = doc.identifier.charAt(0).toUpperCase() + doc.identifier.slice(1);
            if (evidence.includes(capitalizedIdentifier)) {
                console.log(`⏭️ Skipping ParcelID: ${doc.parcelID} - Evidence "${capitalizedIdentifier}" already uploaded`);
                return true;
            }
        }
    } else if (doc.type === DocumentType.MISC) {
        if (isArbitraryMiscDoc(doc)) {
            // Arbitrary misc documents dedup by the specific file AND the doc type it was filed under,
            // so distinct documents (e.g. multiple exhibits) for the same parcel/year still upload, and
            // the same file filed under two different NYSCEF types counts as two distinct filings.
            // S3Key is content-derived upstream, so a corrected re-send is a new key and re-uploads.
            const checkQuery = `SELECT ID FROM Court.UploadedMiscDocs WHERE ParcelID = ? AND Year = ? AND S3Key = ? AND DocType = ?`;
            const result = (await executeSQLQuery(checkQuery, [doc.parcelID, doc.year, doc.s3Key, doc.identifier])) as Array<{ ID: number }>;
            if (result && result.length > 0) {
                console.log(`⏭️ Skipping ParcelID: ${doc.parcelID} - Misc document (S3Key: ${doc.s3Key}, DocType: ${doc.identifier}) already uploaded`);
                return true;
            }
        } else {
            // Legacy letters (and legacy direct-invoke misc docs) dedup by parcel/year.
            const checkQuery = `SELECT ParcelID FROM Court.UploadedLetters WHERE ParcelID = ? AND Year = ?`;
            const result = (await executeSQLQuery(checkQuery, [doc.parcelID, doc.year])) as Array<{ ParcelID: string }>;
            if (result && result.length > 0) {
                console.log(`⏭️ Skipping ParcelID: ${doc.parcelID} - Letter already uploaded`);
                return true;
            }
        }
    }
    return false;
}
