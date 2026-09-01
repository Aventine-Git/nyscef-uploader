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
    description: string | null; // NYSCEF document description; exhibit description (EXHIBIT) or Additional Document Information box (LETTER)
    s3Key: string; // queue row's S3Key; used as the dedup identity for arbitrary misc documents
    exhibitLabelMode: ExhibitLabelMode | null; // per-filing override; null = auto (see computeNextExhibitLabel)
    hasBeenUploaded: boolean;
    wasSkipped: boolean;
    forceUpload: boolean;
    // NYSCEF's confirmation/document reference, scraped from the post-submit page. Only set once a
    // filing has been positively confirmed, so its presence is the evidence that hasBeenUploaded
    // means "on the docket" rather than "we pressed submit". Undefined in testing mode, and when
    // NYSCEF confirms without exposing a reference.
    confirmationRef?: string;
    // Originating Court.NyscefUploadQueue row, when this document came from the queue. Used to
    // stamp SubmittedAt before the filing is submitted, so a crash mid-filing can be told apart
    // from a crash before it. Undefined for direct invocations, which have no queue row.
    queueItemID?: number;
    // The exhibit number/letter typed into #txtExhNumLet_1 ('3', 'B'…), and the docket we read to
    // choose it ('1, 2, 3, 4, 3 of 6'). Set on the exhibit path only, as soon as the label is
    // picked — but carried in memory rather than written there, because at that point nothing has
    // been submitted yet. queueClient.recordExhibitLabel persists them after the verdict.
    //
    // The snapshot exists because the label alone is the less useful half: on 803936/2025 it was the
    // scraped docket, not our own number, that revealed an exhibit filed by hand over a label we had
    // already used.
    exhibitLabel?: string;
    exhibitDocketSnapshot?: string;
}

// How exhibits are labeled on a filing. NUMBER (1, 2, 3…) is the default: we file as the
// petitioner, and NY convention numbers petitioner exhibits and letters respondent exhibits.
// LETTER (A, B, C…) is available per-filing for judges who ask for lettered exhibits.
export type ExhibitLabelMode = 'NUMBER' | 'LETTER';

export const EXHIBIT_LABEL_MODES: readonly ExhibitLabelMode[] = ['NUMBER', 'LETTER'];

// Normalizes a raw queue-row/payload value into an ExhibitLabelMode. Unrecognized values fall back
// to null (= auto) with a warning rather than failing the filing, mirroring resolveMiscDocType.
export function parseExhibitLabelMode(raw: string | null | undefined, context: string): ExhibitLabelMode | null {
    const value = raw?.trim().toUpperCase();
    if (!value) return null;
    if ((EXHIBIT_LABEL_MODES as readonly string[]).includes(value)) return value as ExhibitLabelMode;
    console.warn(`⚠️ Unrecognized ExhibitLabelMode '${raw}' for ${context} — falling back to automatic labeling. Valid values: ${EXHIBIT_LABEL_MODES.join(', ')}.`);
    return null;
}

export enum DocumentType {
    STIPULATION = 'STIPULATION',
    EVIDENCE = 'EVIDENCE',
    MISC = 'MISC',
}

/**
 * What a STIPULATION-type document actually files as with the court.
 *
 * `Document.identifier` for a stipulation is the raw disposition code copied from
 * `Courtfiles.SCARDeterminationAction` — S, SD, ST, W, OA, NM, D, AH. Most of those describe *how* a
 * case settled and all produce the same settlement stipulation; only 'W' and 'OA' produce a
 * genuinely different document. Both the NYSCEF doc-type dropdown (getStipDocType) and the duplicate
 * guard (checkAlreadyUploaded) care about that outcome rather than the raw code, and they derive it
 * from here so the two can never disagree about what a code means.
 *
 * Classes, not raw codes, is what makes the guard correct in both directions: 'S' and 'SD' are not
 * two different filings and must still dedup against each other, while a withdrawal on a case whose
 * settlement stip is already filed is a distinct document and must be allowed through.
 *
 * IMPORTANT: keep in sync with `classifyStip` in stipulation-ingest/src/types.ts, which runs the
 * same check one stage earlier. The two lambdas live in separate repos and cannot share a module.
 */
export type StipClass = 'WITHDRAWAL' | 'ADJOURNMENT' | 'SETTLEMENT';

export function classifyStip(identifier: string | null | undefined): StipClass {
    switch (identifier?.trim().toUpperCase()) {
        case 'W':
            return 'WITHDRAWAL';
        case 'OA':
            return 'ADJOURNMENT';
        default:
            return 'SETTLEMENT';
    }
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

/**
 * Human-readable name for a batch of documents, used in notification subjects and headings.
 *
 * MISC is not a synonym for "Letter": it also carries exhibits and arbitrary supporting documents,
 * which mirrors resolveMiscDocType's mapping (only the LETTER code files as correspondence — every
 * other code, including unrecognized ones, files as EXHIBIT(S)). Calling all of them "Letter" told
 * negotiators the wrong thing about what was just filed with the court.
 */
export function describeUploadType(documents: Document[]): string {
    if (documents.some((d) => d.type === DocumentType.EVIDENCE)) return 'Evidence';

    const misc = documents.filter((d) => d.type === DocumentType.MISC);
    if (misc.length > 0) {
        const labels = new Set(misc.map((d) => (d.identifier.trim().toUpperCase() === 'LETTER' ? 'Letter' : 'Exhibit')));
        // A mixed batch has no single accurate name — stay generic rather than pick a side.
        return labels.size === 1 ? [...labels][0] : 'Document';
    }

    return 'Stipulation';
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
