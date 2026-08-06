import { executeSQLQuery } from '../shared_helpers/sql.js';
import { classifyStip, Document, DocumentType, isArbitraryMiscDoc, StipClass } from '../types.js';

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
 * Which kinds of stipulation have already been filed for this parcel/year, per the upload queue.
 *
 * The queue is the only record of *what* was filed — it carries the disposition in `Identifier`,
 * which `StipTracking.Status` does not. That distinction is the whole point: a settlement and a
 * withdrawal are different documents on the same case, and a case that settles and is then
 * withdrawn has to be able to file both.
 *
 * Consulted in preference to `StipTracking.Status` because that column is also not a durable record
 * that anything was filed at all. stipulation-ingest calls `setCountersign` on every batch it
 * accepts, resetting Status to 'Countersigned' *before* it queues anything — so on a re-sent batch
 * the evidence of the earlier filing is gone by the time this guard runs. Court.NyscefUploadQueue
 * is append-only: nothing rewrites a row once it reaches UPLOADED.
 *
 * Returned as classes rather than raw codes so the several codes that file an identical settlement
 * stipulation ('S', 'SD', 'ST' …) still dedup against one another.
 *
 * The row being processed right now cannot match itself — it only becomes UPLOADED after a
 * successful filing, and it is QUEUED or PROCESSING at this point. Testing rows are excluded
 * because they never reach the portal, so they must not block a real filing.
 */
async function filedStipClasses(parcelID: string, year: number): Promise<Set<StipClass>> {
    const rows = (await executeSQLQuery(
        `SELECT DISTINCT Identifier FROM Court.NyscefUploadQueue
          WHERE ParcelID = ? AND Year = ? AND DocumentType = 'STIPULATION' AND Status = 'UPLOADED' AND Testing = 0`,
        [parcelID, year]
    )) as Array<{ Identifier: string }> | undefined;
    return new Set((rows ?? []).map((r) => classifyStip(r.Identifier)));
}

export async function checkAlreadyUploaded(doc: Document, realFrom: string): Promise<boolean> {
    console.log(`Checking if document has already been uploaded for ParcelID: ${doc.parcelID}, Year: ${doc.year}`);
    if (realFrom.toLowerCase().includes('propriety')) {
        console.log('RealFrom indicates Propriety — skipping already uploaded check to allow re-uploads from Propriety.');
        return false;
    }

    if (doc.type === DocumentType.STIPULATION) {
        const incoming = classifyStip(doc.identifier);

        // The queue is asked first and, whenever it knows anything about this parcel/year, it is the
        // answer. It is the only source that records *which* document was filed; StipTracking.Status
        // records merely that something was. Letting the coarse signal answer first is what silently
        // blocked a withdrawal on a case whose settlement stip had already been filed — the two are
        // different filings, and the court needs both.
        const filed = await filedStipClasses(doc.parcelID, doc.year);
        if (filed.size > 0) {
            if (filed.has(incoming)) {
                console.log(`⏭️ Skipping ParcelID: ${doc.parcelID} - a ${incoming} stipulation is already filed for ${doc.year}`);
                return true;
            }
            console.log(
                `➡️ ParcelID: ${doc.parcelID} - prior filing(s) for ${doc.year}: [${[...filed].join(', ')}]; ` +
                    `incoming is ${incoming}, a distinct document. Proceeding with upload.`
            );
            return false;
        }

        // Nothing in the queue: a filing that predates Court.NyscefUploadQueue (Feb 2026), where
        // StipTracking is the only surviving evidence. It cannot say which document was filed, so it
        // has to block every class — a deliberate re-file on such a case needs forceUpload.
        //
        // `.some`, not `result[0]`: StipTracking is keyed (ParcelID, Year, Stage, CaseType) and this
        // lookup supplies only half that key, so which row came back first was arbitrary.
        const checkQuery = `SELECT Status FROM StipTracking WHERE ParcelID = ? AND Year = ?`;
        const result = (await executeSQLQuery(checkQuery, [doc.parcelID, doc.year])) as Array<{ Status: string }>;
        if (result && result.some((r) => FILED_STIP_STATUSES.includes(r.Status))) {
            console.log(
                `⏭️ Skipping ParcelID: ${doc.parcelID} - Stipulation already uploaded (legacy filing with no queue row; ` +
                    `StipTracking cannot distinguish a ${incoming} from what was filed)`
            );
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
