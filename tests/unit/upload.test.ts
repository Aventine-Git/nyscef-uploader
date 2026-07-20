import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeNextExhibitLabel, filterToOurExhibits, resolveMiscDocType } from '../../src/uploader/upload.ts';
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
        exhibitLabelMode: null,
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

const SCAR_ID = '9999/2025';

describe('computeNextExhibitLabel', () => {
    describe('default (NUMBER) mode', () => {
        it('starts at 1 on a case with no exhibits of ours', () => {
            expect(computeNextExhibitLabel([], null, SCAR_ID)).toBe('1');
        });

        it('continues an existing numbered sequence', () => {
            expect(computeNextExhibitLabel(['1', '2'], null, SCAR_ID)).toBe('3');
        });

        it('uses max+1 rather than filling gaps', () => {
            expect(computeNextExhibitLabel(['1', '3'], null, SCAR_ID)).toBe('4');
        });

        it('compares numerically, not lexicographically', () => {
            // '9' > '10' as strings — a string max would wrongly return 10 here.
            expect(computeNextExhibitLabel(['9', '10'], null, SCAR_ID)).toBe('11');
        });

        it('has no ceiling', () => {
            expect(computeNextExhibitLabel(['999'], null, SCAR_ID)).toBe('1000');
        });
    });

    describe('per-case continuity', () => {
        it('keeps lettering when we already filed lettered exhibits on this case', () => {
            expect(computeNextExhibitLabel(['A', 'B'], null, SCAR_ID)).toBe('C');
        });

        it('uses max+1 for letters too, leaving gaps alone', () => {
            expect(computeNextExhibitLabel(['A', 'C'], null, SCAR_ID)).toBe('D');
        });

        it('prefers lettering when our history is mixed', () => {
            // A case that started lettered and picked up a stray number stays lettered rather
            // than silently switching mid-docket.
            expect(computeNextExhibitLabel(['A', '1'], null, SCAR_ID)).toBe('B');
        });
    });

    describe('explicit override', () => {
        it('LETTER override starts at A on a fresh case', () => {
            expect(computeNextExhibitLabel([], 'LETTER', SCAR_ID)).toBe('A');
        });

        it('NUMBER override beats continuity with our lettered filings', () => {
            expect(computeNextExhibitLabel(['A', 'B'], 'NUMBER', SCAR_ID)).toBe('1');
        });

        it('LETTER override applies to a numbered case', () => {
            expect(computeNextExhibitLabel(['1', '2'], 'LETTER', SCAR_ID)).toBe('A');
        });
    });

    describe('letter exhaustion', () => {
        it('throws once Z is reached, naming the scarID', () => {
            expect(() => computeNextExhibitLabel(['Z'], null, SCAR_ID)).toThrow(/exhausted \(A-Z\).*9999\/2025/i);
        });

        it('does not throw in NUMBER mode even past Z', () => {
            expect(computeNextExhibitLabel(['Z'], 'NUMBER', SCAR_ID)).toBe('1');
        });
    });

    it('ignores unparseable labels rather than failing the filing', () => {
        expect(computeNextExhibitLabel(['AA', '', 'A-1'], null, SCAR_ID)).toBe('1');
    });
});

describe('filterToOurExhibits', () => {
    const OURS = 'Burns, James';
    const scraped = [
        { label: 'A', filerName: OURS },
        { label: '1', filerName: 'Assessor, Town of Smithtown' },
        { label: 'B', filerName: OURS },
    ];

    it('keeps only exhibits filed by us', () => {
        expect(filterToOurExhibits(scraped, OURS)).toEqual(['A', 'B']);
    });

    it('matches the filer name case-insensitively', () => {
        expect(filterToOurExhibits(scraped, 'burns, james')).toEqual(['A', 'B']);
    });

    it('returns nothing when no filerName is configured', () => {
        expect(filterToOurExhibits(scraped, '')).toEqual([]);
    });

    it('returns nothing when the filerName matches no row', () => {
        expect(filterToOurExhibits(scraped, 'Somebody Else')).toEqual([]);
    });

    it('the opposing party alone leaves us starting fresh at 1', () => {
        const theirs = [{ label: '1', filerName: 'Assessor, Town of Smithtown' }];
        const ours = filterToOurExhibits(theirs, OURS);
        expect(computeNextExhibitLabel(ours, null, SCAR_ID)).toBe('1');
    });

    it('our lettered history survives the filter and drives continuity', () => {
        const ours = filterToOurExhibits(scraped, OURS);
        expect(computeNextExhibitLabel(ours, null, SCAR_ID)).toBe('C');
    });
});
