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
    identifier: string; // disposition for stipulations, evidence type for evidence, or type for misc
    hasBeenUploaded: boolean;
    wasSkipped: boolean;
    forceUpload: boolean;
}

export enum DocumentType {
    STIPULATION = 'STIPULATION',
    EVIDENCE = 'EVIDENCE',
    MISC = 'MISC',
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
