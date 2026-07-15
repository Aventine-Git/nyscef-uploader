import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveMiscDocType } from '../../src/uploader/upload.ts';
import { Document, DocumentType, isArbitraryMiscDoc } from '../../src/types.ts';

const EXHIBIT_LABEL = 'EXHIBIT(S)';
const LETTER_LABEL = 'LETTER / CORRESPONDENCE TO JUDGE';

function miscDoc(identifier: string): Document {
    return {
        type: DocumentType.MISC,
        scarID: '9999/2025',
        parcelID: 'WES-001',
        year: 2025,
        municode: 'WES',
        county: 'Westchester',
        negotiatorID: null,
        isVillage: false,
        docBuffer: Buffer.from('pdf'),
        identifier,
        description: null,
        s3Key: 'misc/WES-001.pdf',
        hasBeenUploaded: false,
        wasSkipped: false,
        forceUpload: false,
    };
}

describe('resolveMiscDocType', () => {
    it('maps EXHIBIT code to EXHIBIT(S)', () => {
        expect(resolveMiscDocType(miscDoc('EXHIBIT'))).toBe(EXHIBIT_LABEL);
    });

    it('maps LETTER code to the Letter/Correspondence label', () => {
        expect(resolveMiscDocType(miscDoc('LETTER'))).toBe(LETTER_LABEL);
    });

    it('is case-insensitive (legacy lower-case "letter" still maps to Letter)', () => {
        expect(resolveMiscDocType(miscDoc('letter'))).toBe(LETTER_LABEL);
    });

    it('defaults unknown codes to EXHIBIT(S)', () => {
        expect(resolveMiscDocType(miscDoc('something-new'))).toBe(EXHIBIT_LABEL);
    });

    it('defaults an empty identifier to EXHIBIT(S)', () => {
        expect(resolveMiscDocType(miscDoc(''))).toBe(EXHIBIT_LABEL);
    });
});

// An unmapped code means the allowlist drifted between the two repos. We still file (defaulting to
// EXHIBIT(S)) but must say so — otherwise the doc is filed under the wrong type with no signal.
describe('resolveMiscDocType — allowlist drift warning', () => {
    afterEach(() => vi.restoreAllMocks());

    it('warns when a non-empty code is unmapped', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        resolveMiscDocType(miscDoc('AFFIDAVIT'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('AFFIDAVIT'));
    });

    it('does not warn for a mapped code', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        resolveMiscDocType(miscDoc('LETTER'));
        expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn for an empty code', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        resolveMiscDocType(miscDoc(''));
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('isArbitraryMiscDoc', () => {
    it('true for a queue-backed misc doc with a doc-type code', () => {
        expect(isArbitraryMiscDoc(miscDoc('EXHIBIT'))).toBe(true);
    });

    it('false for a legacy letter', () => {
        expect(isArbitraryMiscDoc(miscDoc('letter'))).toBe(false);
    });

    it('false when there is no s3Key (legacy direct-invoke path)', () => {
        expect(isArbitraryMiscDoc({ ...miscDoc('S'), s3Key: '' })).toBe(false);
    });

    it('false for non-MISC document types', () => {
        expect(isArbitraryMiscDoc({ ...miscDoc('EXHIBIT'), type: DocumentType.EVIDENCE })).toBe(false);
    });
});
