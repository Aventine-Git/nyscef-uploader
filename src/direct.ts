/* eslint-disable @typescript-eslint/no-explicit-any */
import { DocInputData, Document, DocumentType, EventInput } from './types.js';
import { getS3, listS3 } from './shared_helpers/s3.js';
import { Readable } from 'stream';
import { streamToBuffer } from './helpers/buffer.js';
import { getCountyCodeMap } from './helpers/countyCode.js';
import { getNegotiatorID } from './helpers/negotiator.js';
import { determineIsVillage } from './helpers/determineIsVillage.js';
import { uploadToNyscef } from './uploader.js';
import { emailSCARClerk } from './emailer/emailSCARClerk.js';
import { notifyResults } from './emailer/notifyResults.js';
import { handleWithdrawals } from './helpers/withdrawals.js';

async function enrichDoc(doc: any, countyCodeMap: Record<string, string>): Promise<void> {
    if (!doc.countyCode || doc.countyCode.trim() === '' || doc.countyCode.length < 3) {
        doc.countyCode = doc.parcelID.substring(0, 3);
    }
    if (!doc.county) {
        doc.county = countyCodeMap[doc.parcelID.substring(0, 1)];
        if (!doc.county) throw new Error(`Unable to determine county for parcelID: ${doc.parcelID}`);
    }
    if (doc.negotiatorID === undefined || doc.negotiatorID === null) {
        doc.negotiatorID = await getNegotiatorID(doc.scarID);
    }
    if (doc.isVillage === undefined || doc.isVillage === null) {
        doc.isVillage = await determineIsVillage(doc.scarID);
    }
    if (doc.evidenceTypes) {
        doc.evidenceTypes = doc.evidenceTypes.map((et: string) => et.toLowerCase());
        const needsUnequal = doc.evidenceTypes.includes('unequal') && !doc.unequalBufferKey;
        const needsExcessive = doc.evidenceTypes.includes('excessive') && !doc.excessiveBufferKey;
        if (needsUnequal || needsExcessive) {
            const list = await listS3('aventine-court-docs', `residential/evidence/${doc.year}/${doc.parcelID}/`);
            if (needsUnequal) {
                const key = doc.isVillage
                    ? list.Contents?.find((item: any) => item.Key?.includes('village'))?.Key
                    : list.Contents?.find((item: any) => item.Key?.includes('sales') && item.Key?.includes('fnma'))?.Key;
                if (!key) throw new Error(`No unequal evidence file found for parcelID ${doc.parcelID}`);
                doc.unequalBufferKey = key;
            }
            if (needsExcessive) {
                const key = list.Contents?.find((item: any) => item.Key?.includes('equity'))?.Key;
                if (!key) throw new Error(`No excessive evidence file found for parcelID ${doc.parcelID}`);
                doc.excessiveBufferKey = key;
            }
        }
    }
}

async function buildDocumentsFromInput(d: DocInputData, forceUpload: boolean): Promise<Document[]> {
    const base = {
        scarID: d.scarID,
        parcelID: d.parcelID,
        year: d.year,
        municode: d.parcelID[3] === '0' && d.parcelID[4] === '0' ? d.parcelID.substring(0, 3) : d.parcelID.substring(0, 5),
        county: d.county,
        negotiatorID: d.negotiatorID,
        isVillage: d.isVillage,
        description: null,
        s3Key: '', // legacy direct path has no queue row; misc dedup does not apply here
        hasBeenUploaded: false,
        wasSkipped: false,
        forceUpload,
    };
    if (d.evidenceTypes && d.evidenceTypes.length > 0) {
        const docs: Document[] = [];
        for (const evidenceType of d.evidenceTypes) {
            const bufferKey = evidenceType === 'unequal' ? d.unequalBufferKey : evidenceType === 'excessive' ? d.excessiveBufferKey : undefined;
            if (!bufferKey) continue;
            const s3Object = await getS3('aventine-court-docs', bufferKey);
            const buffer = await streamToBuffer(s3Object.Body as Readable);
            docs.push({ ...base, type: DocumentType.EVIDENCE, docBuffer: buffer, identifier: evidenceType });
        }
        return docs;
    } else if (d.stipBufferKey) {
        const s3Object = await getS3('stipulation-ingest-files', 'pdfs/' + d.stipBufferKey);
        const buffer = await streamToBuffer(s3Object.Body as Readable);
        return [{ ...base, type: DocumentType.STIPULATION, docBuffer: buffer, identifier: d.disposition! }];
    } else if (d.miscBufferKey) {
        const s3Object = await getS3('aventine-court-docs', d.miscBufferKey);
        const buffer = await streamToBuffer(s3Object.Body as Readable);
        return [{ ...base, type: DocumentType.MISC, docBuffer: buffer, identifier: d.disposition ?? 'letter' }];
    }
    throw new Error(`Document must have stipBufferKey (stipulation), evidenceTypes (evidence), or miscBufferKey (misc letter): ${JSON.stringify(d)}`);
}

export async function processDirectInvocation(event: EventInput): Promise<void> {
    const { documents, testing = false, ingestID = null, realFrom = '', forceUpload = false } = event;
    const countyCodeMap = await getCountyCodeMap();
    for (const doc of documents) {
        await enrichDoc(doc, countyCodeMap);
    }
    const docs: Document[] = (await Promise.all(documents.map((d) => buildDocumentsFromInput(d, forceUpload)))).flat();
    try {
        const output = await uploadToNyscef(docs, testing, ingestID ?? undefined, realFrom);
        await emailSCARClerk(output, realFrom, testing);
        await handleWithdrawals(output, testing);
        const uploadedCount = output.filter((d) => d.hasBeenUploaded && !d.wasSkipped).length;
        const skippedCount = output.filter((d) => d.wasSkipped).length;
        const resultStr =
            [uploadedCount > 0 ? `${uploadedCount} Uploaded` : '', skippedCount > 0 ? `${skippedCount} Skipped (already uploaded)` : ''].filter(Boolean).join(', ') ||
            'None processed';
        await notifyResults(resultStr, output, undefined, undefined, testing);
    } catch (error: any) {
        await notifyResults(error.message, docs, error.failedDoc, error.screenshot, testing, true);
        throw error;
    }
}
