import { executeSQLQuery } from '../shared_helpers/sql.js';
import { Document, DocumentType, isArbitraryMiscDoc } from '../types.js';

export async function checkAlreadyUploaded(doc: Document, realFrom: string): Promise<boolean> {
    console.log(`Checking if document has already been uploaded for ParcelID: ${doc.parcelID}, Year: ${doc.year}`);
    if (realFrom.toLowerCase().includes('propriety')) {
        console.log('RealFrom indicates Propriety — skipping already uploaded check to allow re-uploads from Propriety.');
        return false;
    }

    if (doc.type === DocumentType.STIPULATION) {
        const checkQuery = `SELECT Status FROM StipTracking WHERE ParcelID = ? AND Year = ?`;
        const result = (await executeSQLQuery(checkQuery, [doc.parcelID, doc.year])) as Array<{ Status: string }>;
        if (result && result.length > 0 && result[0].Status === 'NyscefUploaded') {
            console.log(`⏭️ Skipping ParcelID: ${doc.parcelID} - Stipulation already uploaded`);
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
