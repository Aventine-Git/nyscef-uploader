import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../../src/shared_helpers/sql.js', () => ({
    executeSQLQuery: vi.fn(),
    getUserDetails: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/shared_helpers/s3.js', () => ({
    putS3: vi.fn().mockResolvedValue(true),
}));

import fetch from 'node-fetch';
import { executeSQLQuery } from '../../src/shared_helpers/sql.js';
import { putS3 } from '../../src/shared_helpers/s3.js';

import { findFirstValidCountyCode, getCountyCodeMap } from '../../src/helpers/countyCode.ts';
import { retry } from '../../src/helpers/retry.ts';
import { findFirstValidNegotiatorID, getNegotiatorID } from '../../src/helpers/negotiator.ts';
import { determineIsVillage } from '../../src/helpers/determineIsVillage.ts';
import { handleWithdrawals } from '../../src/helpers/withdrawals.ts';
import { Document, DocumentType } from '../../src/types.ts';

const mockFetch = vi.mocked(fetch);
const mockSQL = vi.mocked(executeSQLQuery);
const mockPutS3 = vi.mocked(putS3);

beforeEach(() => vi.clearAllMocks());

// ─── Helpers: Document fixture ────────────────────────────────────────────────

function doc(overrides: Partial<Document> = {}): Document {
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
        identifier: 'W',
        hasBeenUploaded: true,
        wasSkipped: false,
        forceUpload: false,
        ...overrides,
    };
}

// ─── findFirstValidCountyCode ─────────────────────────────────────────────────

describe('findFirstValidCountyCode', () => {
    it('returns the first non-empty municode', () => {
        expect(findFirstValidCountyCode([doc({ municode: '' }), doc({ municode: 'SUF' })])).toBe('SUF');
    });
    it('returns null when all municodes are empty or whitespace', () => {
        expect(findFirstValidCountyCode([doc({ municode: '' }), doc({ municode: '   ' })])).toBeNull();
    });
    it('returns null for empty array', () => {
        expect(findFirstValidCountyCode([])).toBeNull();
    });
    it('returns first valid when first is non-empty', () => {
        expect(findFirstValidCountyCode([doc({ municode: 'WES' }), doc({ municode: 'SUF' })])).toBe('WES');
    });
});

// ─── getCountyCodeMap ─────────────────────────────────────────────────────────

describe('getCountyCodeMap', () => {
    it('fetches and returns the county code map', async () => {
        const map = { Westchester: 'WES', Suffolk: 'SUF' };
        mockFetch.mockResolvedValueOnce({ json: async () => map } as any);
        const result = await getCountyCodeMap();
        expect(result).toEqual(map);
        expect(mockFetch).toHaveBeenCalledWith('https://api.aventineproperties.com/counties');
    });
});

// ─── retry ────────────────────────────────────────────────────────────────────

describe('retry', () => {
    it('returns result on first successful attempt', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        const result = await retry(fn, 'error', 3, 0);
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledOnce();
    });

    it('retries on failure and succeeds on second attempt', async () => {
        const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok');
        const result = await retry(fn, 'error', 3, 0);
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws after maxRetries exhausted', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('always fails'));
        await expect(retry(fn, 'human error', 3, 0)).rejects.toThrow('always fails');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('sets humanError message on the thrown error', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('raw'));
        let caught: any;
        try {
            await retry(fn, 'human error msg', 2, 0);
        } catch (e) {
            caught = e;
        }
        expect(caught.Message).toBe('human error msg');
    });

    it('defaults to 3 retries', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('fail'));
        await expect(retry(fn, 'error', undefined, 0)).rejects.toThrow();
        expect(fn).toHaveBeenCalledTimes(3);
    });
});

// ─── findFirstValidNegotiatorID ───────────────────────────────────────────────

describe('findFirstValidNegotiatorID', () => {
    it('returns first non-null negotiatorID', () => {
        expect(findFirstValidNegotiatorID([doc({ negotiatorID: null }), doc({ negotiatorID: 7 })])).toBe(7);
    });
    it('returns null when all are null', () => {
        expect(findFirstValidNegotiatorID([doc({ negotiatorID: null })])).toBeNull();
    });
    it('returns null for empty array', () => {
        expect(findFirstValidNegotiatorID([])).toBeNull();
    });
    it('returns first when first is valid', () => {
        expect(findFirstValidNegotiatorID([doc({ negotiatorID: 3 }), doc({ negotiatorID: 9 })])).toBe(3);
    });
});

// ─── getNegotiatorID ──────────────────────────────────────────────────────────

describe('getNegotiatorID', () => {
    it('returns negotiator ID when found', async () => {
        mockSQL.mockResolvedValueOnce([{ Negotiator: 5 }] as any);
        expect(await getNegotiatorID('9999/2025')).toBe(5);
    });
    it('returns null when no result', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        expect(await getNegotiatorID('9999/2025')).toBeNull();
    });
});

// ─── determineIsVillage ───────────────────────────────────────────────────────

describe('determineIsVillage', () => {
    it('returns true when a matching VillageSCARIndexNumber row exists', async () => {
        mockSQL.mockResolvedValueOnce([{ VillageSCARIndexNumber: '9999/2025' }] as any);
        expect(await determineIsVillage('9999/2025')).toBe(true);
    });
    it('returns false when no matching row exists', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        expect(await determineIsVillage('9999/2025')).toBe(false);
    });
});

// ─── handleWithdrawals ────────────────────────────────────────────────────────

describe('handleWithdrawals', () => {
    it('skips non-STIPULATION documents', async () => {
        await handleWithdrawals([doc({ type: DocumentType.EVIDENCE, identifier: 'W', hasBeenUploaded: true })]);
        expect(mockPutS3).not.toHaveBeenCalled();
    });

    it('skips MISC documents', async () => {
        await handleWithdrawals([doc({ type: DocumentType.MISC, identifier: 'letter', hasBeenUploaded: true })]);
        expect(mockPutS3).not.toHaveBeenCalled();
    });

    it('skips stipulations with identifier != W', async () => {
        await handleWithdrawals([doc({ identifier: 'S', hasBeenUploaded: true })]);
        expect(mockPutS3).not.toHaveBeenCalled();
    });

    it('skips documents that have not been uploaded', async () => {
        await handleWithdrawals([doc({ identifier: 'W', hasBeenUploaded: false })]);
        expect(mockPutS3).not.toHaveBeenCalled();
    });

    it('skips processing in testing mode', async () => {
        await handleWithdrawals([doc({ identifier: 'W', hasBeenUploaded: true })], true);
        expect(mockPutS3).not.toHaveBeenCalled();
        expect(mockSQL).not.toHaveBeenCalled();
    });

    it('uploads to S3 and updates DB for valid withdrawal', async () => {
        mockSQL.mockResolvedValueOnce({ affectedRows: 1 } as any);
        await handleWithdrawals([doc({ identifier: 'W', hasBeenUploaded: true, isVillage: false })], false);
        expect(mockPutS3).toHaveBeenCalledOnce();
        expect(mockSQL).toHaveBeenCalledOnce();
    });

    it('uses VillageSCARDeterminationDate column when isVillage=true', async () => {
        mockSQL.mockResolvedValueOnce({ affectedRows: 1 } as any);
        await handleWithdrawals([doc({ identifier: 'W', hasBeenUploaded: true, isVillage: true })], false);
        const query: string = mockSQL.mock.calls[0][0] as string;
        expect(query).toContain('VillageSCARDeterminationDate');
    });

    it('uses SCARDeterminationDate column when isVillage=false', async () => {
        mockSQL.mockResolvedValueOnce({ affectedRows: 1 } as any);
        await handleWithdrawals([doc({ identifier: 'W', hasBeenUploaded: true, isVillage: false })], false);
        const query: string = mockSQL.mock.calls[0][0] as string;
        expect(query).toContain('SCARDeterminationDate');
        expect(query).not.toContain('Village');
    });

    it('does not throw when putS3 throws — just logs', async () => {
        mockPutS3.mockRejectedValueOnce(new Error('S3 down'));
        await expect(handleWithdrawals([doc({ identifier: 'W', hasBeenUploaded: true })], false)).resolves.not.toThrow();
    });

    it('processes multiple withdrawals in sequence', async () => {
        mockSQL.mockResolvedValue({ affectedRows: 1 } as any);
        const docs = [doc({ parcelID: 'WES-001', identifier: 'W', hasBeenUploaded: true }), doc({ parcelID: 'WES-002', identifier: 'W', hasBeenUploaded: true })];
        await handleWithdrawals(docs, false);
        expect(mockPutS3).toHaveBeenCalledTimes(2);
        expect(mockSQL).toHaveBeenCalledTimes(2);
    });
});
