import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared_helpers/sql.js', () => ({
    executeSQLQuery: vi.fn(),
    getUserDetails: vi.fn().mockResolvedValue(null),
}));

import { executeSQLQuery } from '../../src/shared_helpers/sql.js';
import { checkAlreadyUploaded } from '../../src/uploader/checkAlreadyUploaded.ts';
import { Document, DocumentType } from '../../src/types.ts';

const mockSQL = vi.mocked(executeSQLQuery);

// mockReset, not just clearAllMocks: clearAllMocks resets recorded calls but leaves any unconsumed
// mockResolvedValueOnce values queued, so a test that queues more responses than it consumes
// silently feeds them to the next one. The stipulation path returns early when the status alone
// proves a prior filing, which makes that imbalance easy to introduce.
beforeEach(() => {
    vi.clearAllMocks();
    mockSQL.mockReset();
});

function stipDoc(overrides: Partial<Document> = {}): Document {
    return {
        type: DocumentType.STIPULATION,
        scarID: '9999/2025',
        parcelID: 'WES-001',
        year: 2025,
        municode: 'WES',
        county: 'Westchester',
        negotiatorID: 5,
        isVillage: false,
        docBuffer: Buffer.from('pdf'),
        identifier: 'S',
        description: null,
        s3Key: 'pdfs/WES-001.pdf',
        hasBeenUploaded: false,
        wasSkipped: false,
        forceUpload: false,
        ...overrides,
    };
}

function evidenceDoc(identifier = 'Unequal'): Document {
    return { ...stipDoc(), type: DocumentType.EVIDENCE, identifier };
}

// ─── Propriety override ───────────────────────────────────────────────────────

describe('checkAlreadyUploaded — Propriety override', () => {
    it('returns false without querying DB when realFrom contains "propriety"', async () => {
        const result = await checkAlreadyUploaded(stipDoc(), 'upload@propriety.com');
        expect(result).toBe(false);
        expect(mockSQL).not.toHaveBeenCalled();
    });

    it('is case-insensitive for Propriety check', async () => {
        const result = await checkAlreadyUploaded(stipDoc(), 'user@PROPRIETY.COM');
        expect(result).toBe(false);
        expect(mockSQL).not.toHaveBeenCalled();
    });
});

// ─── STIPULATION checks ───────────────────────────────────────────────────────

describe('checkAlreadyUploaded — STIPULATION', () => {
    it('returns true when status is NyscefUploaded', async () => {
        mockSQL.mockResolvedValueOnce([{ Status: 'NyscefUploaded' }] as any);
        expect(await checkAlreadyUploaded(stipDoc(), 'assessor@town.gov')).toBe(true);
    });

    /**
     * The AVE-1889 regression. `SoOrdered` is the state *after* `NyscefUploaded` — the court has
     * so-ordered a stip we already filed — so it is the strongest possible evidence of a prior
     * filing. Comparing the status for equality with 'NyscefUploaded' meant a case stopped being
     * recognised the moment it advanced, and 41 Islip stips were filed a second time.
     */
    it('returns true when status is SoOrdered — past NyscefUploaded, not before it', async () => {
        mockSQL.mockResolvedValueOnce([{ Status: 'SoOrdered' }] as any);
        expect(await checkAlreadyUploaded(stipDoc(), 'assessor@town.gov')).toBe(true);
    });

    it('returns true when any row is filed, even if an arbitrary earlier row is not', async () => {
        // StipTracking is keyed (ParcelID, Year, Stage, CaseType); this lookup supplies half of
        // that, so row order carries no meaning and result[0] was a coin flip.
        mockSQL.mockResolvedValueOnce([{ Status: 'Countersigned' }, { Status: 'SoOrdered' }] as any);
        expect(await checkAlreadyUploaded(stipDoc(), 'assessor@town.gov')).toBe(true);
    });

    it('returns false when status is not a filed status', async () => {
        mockSQL.mockResolvedValueOnce([{ Status: 'Pending' }] as any).mockResolvedValueOnce([] as any);
        expect(await checkAlreadyUploaded(stipDoc(), 'assessor@town.gov')).toBe(false);
    });

    it('returns false when no rows found', async () => {
        mockSQL.mockResolvedValueOnce([] as any).mockResolvedValueOnce([] as any);
        expect(await checkAlreadyUploaded(stipDoc(), 'assessor@town.gov')).toBe(false);
    });

    it('queries with correct parcelID and year', async () => {
        mockSQL.mockResolvedValueOnce([] as any).mockResolvedValueOnce([] as any);
        await checkAlreadyUploaded(stipDoc({ parcelID: 'ABC-123', year: 2024 }), 'a@b.com');
        expect(mockSQL).toHaveBeenCalledWith(expect.stringContaining('StipTracking'), ['ABC-123', 2024]);
    });
});

// ─── STIPULATION: upload-queue fallback ───────────────────────────────────────
// stipulation-ingest calls setCountersign() on every batch it accepts, resetting
// StipTracking.Status to 'Countersigned' *before* it queues anything. On a re-sent batch that wipes
// the record of the earlier filing before this guard ever reads it, which is why the status check
// alone only ever caught re-sends that overlapped the original upload in time.

describe('checkAlreadyUploaded — STIPULATION (upload-queue fallback)', () => {
    it('returns true when the status was reset to Countersigned but the queue shows a prior filing', async () => {
        mockSQL.mockResolvedValueOnce([{ Status: 'Countersigned' }] as any).mockResolvedValueOnce([{ ID: 7299 }] as any);
        expect(await checkAlreadyUploaded(stipDoc(), 'assessor@town.gov')).toBe(true);
    });

    it('returns false when neither the status nor the queue shows a prior filing', async () => {
        mockSQL.mockResolvedValueOnce([{ Status: 'Countersigned' }] as any).mockResolvedValueOnce([] as any);
        expect(await checkAlreadyUploaded(stipDoc(), 'assessor@town.gov')).toBe(false);
    });

    it('counts only UPLOADED, non-testing stipulation rows for this parcel/year', async () => {
        mockSQL.mockResolvedValueOnce([] as any).mockResolvedValueOnce([] as any);
        await checkAlreadyUploaded(stipDoc({ parcelID: 'ABC-123', year: 2024 }), 'a@b.com');

        const [sql, params] = mockSQL.mock.calls[1];
        expect(sql).toContain('Court.NyscefUploadQueue');
        expect(sql).toContain("DocumentType = 'STIPULATION'");
        expect(sql).toContain("Status = 'UPLOADED'");
        expect(sql).toContain('Testing = 0');
        expect(params).toEqual(['ABC-123', 2024]);
    });

    it('skips the queue lookup entirely when the status already proves a prior filing', async () => {
        mockSQL.mockResolvedValueOnce([{ Status: 'NyscefUploaded' }] as any);
        await checkAlreadyUploaded(stipDoc(), 'a@b.com');
        expect(mockSQL).toHaveBeenCalledTimes(1);
    });

    it('is not consulted for a Propriety sender, which is allowed to re-file', async () => {
        expect(await checkAlreadyUploaded(stipDoc(), 'upload@propriety.com')).toBe(false);
        expect(mockSQL).not.toHaveBeenCalled();
    });
});

// ─── EVIDENCE checks ─────────────────────────────────────────────────────────

describe('checkAlreadyUploaded — EVIDENCE (identifier matching)', () => {
    it('returns true when evidence array (from DB as array) contains the identifier', async () => {
        mockSQL.mockResolvedValueOnce([{ Evidence: ['Unequal', 'Excessive'] }] as any);
        expect(await checkAlreadyUploaded(evidenceDoc('Unequal'), 'a@b.com')).toBe(true);
    });

    it('returns true when evidence is a JSON string containing the identifier', async () => {
        mockSQL.mockResolvedValueOnce([{ Evidence: '["Unequal","Excessive"]' }] as any);
        expect(await checkAlreadyUploaded(evidenceDoc('Excessive'), 'a@b.com')).toBe(true);
    });

    it('returns true when evidence is a plain string matching the identifier', async () => {
        mockSQL.mockResolvedValueOnce([{ Evidence: 'Unequal' }] as any);
        expect(await checkAlreadyUploaded(evidenceDoc('Unequal'), 'a@b.com')).toBe(true);
    });

    it('returns false when identifier is not in the evidence array', async () => {
        mockSQL.mockResolvedValueOnce([{ Evidence: ['Excessive'] }] as any);
        expect(await checkAlreadyUploaded(evidenceDoc('Unequal'), 'a@b.com')).toBe(false);
    });

    it('returns false when no evidence rows found', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        expect(await checkAlreadyUploaded(evidenceDoc('Unequal'), 'a@b.com')).toBe(false);
    });

    it('capitalizes identifier before comparison (unequal → Unequal)', async () => {
        mockSQL.mockResolvedValueOnce([{ Evidence: ['Unequal'] }] as any);
        expect(await checkAlreadyUploaded(evidenceDoc('unequal'), 'a@b.com')).toBe(true);
    });

    it('returns false when evidence JSON is malformed — treats as single string', async () => {
        mockSQL.mockResolvedValueOnce([{ Evidence: 'not-json' }] as any);
        expect(await checkAlreadyUploaded(evidenceDoc('Unequal'), 'a@b.com')).toBe(false);
    });
});

// ─── MISC checks ──────────────────────────────────────────────────────────────

function miscDoc(overrides: Partial<Document> = {}): Document {
    return { ...stipDoc(), type: DocumentType.MISC, identifier: 'letter', ...overrides };
}

describe('checkAlreadyUploaded — MISC', () => {
    it('returns true when a row exists in UploadedLetters', async () => {
        mockSQL.mockResolvedValueOnce([{ ParcelID: 'WES-001' }] as any);
        expect(await checkAlreadyUploaded(miscDoc(), 'a@b.com')).toBe(true);
    });

    it('returns false when no rows found in UploadedLetters', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        expect(await checkAlreadyUploaded(miscDoc(), 'a@b.com')).toBe(false);
    });

    it('queries UploadedLetters with correct parcelID and year', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        await checkAlreadyUploaded(miscDoc({ parcelID: 'ABC-123', year: 2024 }), 'a@b.com');
        expect(mockSQL).toHaveBeenCalledWith(expect.stringContaining('UploadedLetters'), ['ABC-123', 2024]);
    });

    it('returns false without querying DB when realFrom contains "propriety"', async () => {
        const result = await checkAlreadyUploaded(miscDoc(), 'upload@propriety.com');
        expect(result).toBe(false);
        expect(mockSQL).not.toHaveBeenCalled();
    });
});

// ─── MISC (arbitrary documents — S3Key + DocType dedup) ───────────────────────

function arbitraryMiscDoc(overrides: Partial<Document> = {}): Document {
    return { ...stipDoc(), type: DocumentType.MISC, identifier: 'EXHIBIT', s3Key: 'misc/WES-001_2025_abc123.pdf', ...overrides };
}

describe('checkAlreadyUploaded — MISC (arbitrary documents)', () => {
    it('dedups against UploadedMiscDocs by S3Key AND DocType, not UploadedLetters', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        await checkAlreadyUploaded(arbitraryMiscDoc({ parcelID: 'ABC-123', year: 2024, s3Key: 'misc/x.pdf', identifier: 'EXHIBIT' }), 'a@b.com');
        expect(mockSQL).toHaveBeenCalledWith(expect.stringContaining('UploadedMiscDocs'), ['ABC-123', 2024, 'misc/x.pdf', 'EXHIBIT']);
    });

    it('returns true when the same file + doc type was already uploaded', async () => {
        mockSQL.mockResolvedValueOnce([{ ID: 1 }] as any);
        expect(await checkAlreadyUploaded(arbitraryMiscDoc(), 'a@b.com')).toBe(true);
    });

    it('returns false when not yet uploaded (distinct exhibits still upload)', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        expect(await checkAlreadyUploaded(arbitraryMiscDoc(), 'a@b.com')).toBe(false);
    });

    it('does not touch UploadedLetters for a non-letter misc doc', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        await checkAlreadyUploaded(arbitraryMiscDoc(), 'a@b.com');
        expect(mockSQL).not.toHaveBeenCalledWith(expect.stringContaining('UploadedLetters'), expect.anything());
    });
});

// ─── MISC regression: legacy direct-invoke docs must stay on the UploadedLetters path ─────────
// direct.ts builds Documents with no queue row (s3Key === '') and may set identifier to a
// disposition code. Routing those into UploadedMiscDocs would write dedup rows keyed on an empty
// S3Key and silently skip every later misc doc for that parcel.

describe('checkAlreadyUploaded — MISC (legacy direct-invoke, no s3Key)', () => {
    it('a disposition-identified misc doc with no s3Key uses UploadedLetters, not UploadedMiscDocs', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        await checkAlreadyUploaded(arbitraryMiscDoc({ identifier: 'S', s3Key: '', parcelID: 'ABC-123', year: 2024 }), 'a@b.com');
        expect(mockSQL).toHaveBeenCalledWith(expect.stringContaining('UploadedLetters'), ['ABC-123', 2024]);
        expect(mockSQL).not.toHaveBeenCalledWith(expect.stringContaining('UploadedMiscDocs'), expect.anything());
    });

    it('never queries UploadedMiscDocs with an empty S3Key', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        await checkAlreadyUploaded(arbitraryMiscDoc({ identifier: 'OA', s3Key: '' }), 'a@b.com');
        const miscCalls = mockSQL.mock.calls.filter((c) => String(c[0]).includes('UploadedMiscDocs'));
        expect(miscCalls).toHaveLength(0);
    });
});
