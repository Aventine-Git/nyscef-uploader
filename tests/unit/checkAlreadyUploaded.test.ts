import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../_SHARED/dist/sql.js', () => ({
    executeSQLQuery: vi.fn(),
    getUserDetails: vi.fn().mockResolvedValue(null),
}));

import { executeSQLQuery } from '../../../_SHARED/dist/sql.js';
import { checkAlreadyUploaded } from '../../src/uploader/checkAlreadyUploaded.ts';
import { Document, DocumentType } from '../../src/types.ts';

const mockSQL = vi.mocked(executeSQLQuery);

beforeEach(() => vi.clearAllMocks());

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

    it('returns false when status is not NyscefUploaded', async () => {
        mockSQL.mockResolvedValueOnce([{ Status: 'Pending' }] as any);
        expect(await checkAlreadyUploaded(stipDoc(), 'assessor@town.gov')).toBe(false);
    });

    it('returns false when no rows found', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        expect(await checkAlreadyUploaded(stipDoc(), 'assessor@town.gov')).toBe(false);
    });

    it('queries with correct parcelID and year', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        await checkAlreadyUploaded(stipDoc({ parcelID: 'ABC-123', year: 2024 }), 'a@b.com');
        expect(mockSQL).toHaveBeenCalledWith(expect.stringContaining('StipTracking'), ['ABC-123', 2024]);
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
