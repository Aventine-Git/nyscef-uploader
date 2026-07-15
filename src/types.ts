export interface Document {
    type: DocumentType;
    scarID: string;
    parcelID: string;
    year: number;
    municode: string;
    county: string;
    negotiatorID: number | null;
    isVillage: boolean;
    docBuffer: Buffer;
    identifier: string; // disposition for stipulations, evidence type for evidence, or NYSCEF doc-type code for misc
    description: string | null; // NYSCEF document description; used when filing as EXHIBIT(S)
    s3Key: string; // queue row's S3Key; used as the dedup identity for arbitrary misc documents
    hasBeenUploaded: boolean;
    wasSkipped: boolean;
    forceUpload: boolean;
}

export enum DocumentType {
    STIPULATION = 'STIPULATION',
    EVIDENCE = 'EVIDENCE',
    MISC = 'MISC',
}

// The original MISC document: a motion letter, filed as LETTER / CORRESPONDENCE TO JUDGE and
// deduped in Court.UploadedLetters by parcel/year.
export const LEGACY_LETTER_IDENTIFIER = 'letter';

/**
 * True for the newer "arbitrary miscellaneous document" flow, which is deduped per-file in
 * Court.UploadedMiscDocs rather than per-parcel/year in Court.UploadedLetters.
 *
 * Requires a non-empty s3Key: such docs always originate from a NyscefUploadQueue row. The legacy
 * direct-invocation path (direct.ts) builds Documents with no queue row and therefore no s3Key, and
 * may set identifier to a disposition code — it must keep the UploadedLetters path, or it would
 * write dedup rows keyed on an empty S3Key and silently skip every later misc doc for that parcel.
 */
export function isArbitraryMiscDoc(doc: Document): boolean {
    return (
        doc.type === DocumentType.MISC &&
        doc.identifier.toLowerCase() !== LEGACY_LETTER_IDENTIFIER &&
        doc.s3Key.trim() !== ''
    );
}

// Legacy direct-invocation payload shapes (used when NYSCEF_QUEUE_URL is not configured)
export interface DocInputData {
    scarID: string;
    parcelID: string;
    year: number;
    countyCode: string;
    county: string;
    negotiatorID: number | null;
    isVillage: boolean;
    // stipulation fields
    disposition?: string;
    stipBufferKey?: string;
    // evidence fields
    evidenceTypes?: string[];
    unequalBufferKey?: string;
    excessiveBufferKey?: string;
    // misc fields
    miscBufferKey?: string;
}

export interface EventInput {
    documents: DocInputData[];
    testing?: boolean;
    ingestID?: number | null;
    realFrom?: string;
    forceUpload?: boolean;
}
