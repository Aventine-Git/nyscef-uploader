import { putS3 } from '../shared_helpers/s3.js';
import { Document, DocumentType } from '../types.js';

const NOTIFIER_REPORTS_URL = 'https://notifier-reports.s3.us-east-1.amazonaws.com';

/** Keyed by object identity: two rows can share a ScarID and parcel (a re-sent exhibit). */
export type DocumentLinks = Map<Document, string>;

/** Stipulations are left out: stipulation-ingest's own report already links every page it queued. */
export function linksDocuments(docs: Document[]): boolean {
    return docs.length > 0 && docs[0].type !== DocumentType.STIPULATION;
}

function safeName(part: string): string {
    return part.replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '') || 'document';
}

/**
 * Copy each document into the public notifier-reports bucket so the report can link it. A document
 * that cannot be copied is logged and left unlinked; it must not cost the run its notification.
 */
export async function publishDocuments(docs: Document[]): Promise<DocumentLinks> {
    const links: DocumentLinks = new Map();
    if (!linksDocuments(docs)) return links;

    const runStamp = Date.now();
    for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        const context = `${doc.type} ${doc.scarID || '(no index)'} parcel ${doc.parcelID} (source key ${doc.s3Key || 'none'})`;
        if (doc.docBuffer.length === 0) {
            console.warn(`No document bytes for ${context} - the report will not link it.`);
            continue;
        }
        const filename = `${safeName(doc.scarID || doc.parcelID)}_${safeName(doc.identifier)}.pdf`;
        const key = `attachments/nyscef-upload-${runStamp}/${i + 1}_${filename}`;
        try {
            // `inline`, so the link opens in the browser's PDF viewer instead of downloading.
            await putS3('notifier-reports', key, doc.docBuffer, `inline; filename="${filename}"`, 'application/pdf');
            links.set(doc, `${NOTIFIER_REPORTS_URL}/${key}`);
        } catch (err: unknown) {
            console.error(`Could not copy ${context} to notifier-reports/${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    console.log(`Linked ${links.size}/${docs.length} document(s) in the upload report.`);
    return links;
}
