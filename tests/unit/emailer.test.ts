import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared_helpers/lambda.js', () => ({
    invokeLambda: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/shared_helpers/sql.js', () => ({
    executeSQLQuery: vi.fn(),
    getUserDetails: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/shared_helpers/s3.js', () => ({
    putS3: vi.fn().mockResolvedValue(undefined),
    getS3: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/helpers/screenshot.js', () => ({
    uploadScreenshotToS3: vi.fn().mockResolvedValue('https://s3/screenshot.png'),
    tryScreenshot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/helpers/buffer.js', () => ({
    mergePDFBuffers: vi.fn().mockResolvedValue(Buffer.from('merged')),
}));

import { invokeLambda } from '../../src/shared_helpers/lambda.js';
import { executeSQLQuery, getUserDetails } from '../../src/shared_helpers/sql.js';

import { formatDataTable } from '../../src/emailer/formatDataTable.ts';
import { getClerkEmail } from '../../src/emailer/getClerkEmail.ts';
import getCourtDate from '../../src/emailer/getCourtDate.ts';
import { emailSCARClerk } from '../../src/emailer/emailSCARClerk.ts';
import { notifyResults } from '../../src/emailer/notifyResults.ts';
import { Document, DocumentType } from '../../src/types.ts';

const mockSQL = vi.mocked(executeSQLQuery);
const mockGetUserDetails = vi.mocked(getUserDetails);
const mockInvoke = vi.mocked(invokeLambda);

beforeEach(() => vi.clearAllMocks());

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

// ─── formatDataTable ──────────────────────────────────────────────────────────

describe('formatDataTable', () => {
    it('returns empty string for empty array', () => {
        expect(formatDataTable([])).toBe('');
    });

    it('includes parcelID and scarID in output', () => {
        const html = formatDataTable([doc()]);
        expect(html).toContain('WES-001');
        expect(html).toContain('9999/2025');
    });

    it('shows "Disposition" header for STIPULATION type', () => {
        const html = formatDataTable([doc({ type: DocumentType.STIPULATION })]);
        expect(html).toContain('Disposition');
        expect(html).not.toContain('Evidence Type');
    });

    it('shows "Evidence Type" header for EVIDENCE type', () => {
        const html = formatDataTable([doc({ type: DocumentType.EVIDENCE })]);
        expect(html).toContain('Evidence Type');
        expect(html).not.toContain('Disposition');
    });

    it('shows "Letter Type" header for MISC type', () => {
        const html = formatDataTable([doc({ type: DocumentType.MISC, identifier: 'letter' })]);
        expect(html).toContain('Letter Type');
        expect(html).not.toContain('Disposition');
        expect(html).not.toContain('Evidence Type');
    });

    it('shows UPLOADED status when hasBeenUploaded=true and wasSkipped=false', () => {
        const html = formatDataTable([doc({ hasBeenUploaded: true, wasSkipped: false })]);
        expect(html).toContain('UPLOADED');
    });

    it('shows SKIPPED status when wasSkipped=true', () => {
        const html = formatDataTable([doc({ wasSkipped: true, hasBeenUploaded: true })]);
        expect(html).toContain('SKIPPED (already uploaded)');
    });

    it('shows NOT UPLOADED when hasBeenUploaded=false', () => {
        const html = formatDataTable([doc({ hasBeenUploaded: false, wasSkipped: false })]);
        expect(html).toContain('NOT UPLOADED');
    });

    it('numbers rows sequentially starting at 1', () => {
        const html = formatDataTable([doc({ parcelID: 'A-001' }), doc({ parcelID: 'A-002' })]);
        expect(html).toContain('>1<');
        expect(html).toContain('>2<');
    });

    it('includes county and identifier', () => {
        const html = formatDataTable([doc({ county: 'Westchester', identifier: 'W' })]);
        expect(html).toContain('Westchester');
        expect(html).toContain('>W<');
    });
});

// ─── getClerkEmail ────────────────────────────────────────────────────────────

describe('getClerkEmail', () => {
    it('returns null for empty county', async () => {
        expect(await getClerkEmail('')).toBeNull();
        expect(mockSQL).not.toHaveBeenCalled();
    });

    it('returns null for whitespace-only county', async () => {
        expect(await getClerkEmail('   ')).toBeNull();
    });

    it('returns null when no clerk found', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        expect(await getClerkEmail('Westchester')).toBeNull();
    });

    it('returns email when clerk found', async () => {
        mockSQL.mockResolvedValueOnce([{ Email: 'clerk@westchester.gov' }] as any);
        expect(await getClerkEmail('Westchester')).toBe('clerk@westchester.gov');
    });

    it('trims the county before querying', async () => {
        mockSQL.mockResolvedValueOnce([{ Email: 'clerk@suffolk.gov' }] as any);
        await getClerkEmail('  Suffolk  ');
        expect(mockSQL).toHaveBeenCalledWith(expect.any(String), ['Suffolk']);
    });
});

// ─── getCourtDate ─────────────────────────────────────────────────────────────

describe('getCourtDate', () => {
    it('returns null when no row found', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        expect(await getCourtDate(doc())).toBeNull();
    });

    it('returns null when HearingDate is null', async () => {
        mockSQL.mockResolvedValueOnce([{ HearingDate: null }] as any);
        expect(await getCourtDate(doc())).toBeNull();
    });

    it('formats a Date object as MM-DD-YYYY', async () => {
        mockSQL.mockResolvedValueOnce([{ HearingDate: new Date(2025, 5, 15) }] as any);
        expect(await getCourtDate(doc())).toBe('06-15-2025');
    });

    it('formats a plain YYYY-MM-DD string without shifting the day', async () => {
        // Regression: `new Date('2025-06-15')` is UTC midnight, which reads back as June 14 in any
        // US timezone — every notification would show the day before the real hearing.
        mockSQL.mockResolvedValueOnce([{ HearingDate: '2025-06-15' }] as any);
        expect(await getCourtDate(doc())).toBe('06-15-2025');
    });

    it('formats a full timestamp string on its calendar date', async () => {
        mockSQL.mockResolvedValueOnce([{ HearingDate: '2025-06-15T00:00:00.000Z' }] as any);
        expect(await getCourtDate(doc())).toBe('06-15-2025');
    });

    it('returns null for an unparseable value rather than "NaN-NaN-NaN"', async () => {
        mockSQL.mockResolvedValueOnce([{ HearingDate: 'not a date' }] as any);
        expect(await getCourtDate(doc())).toBeNull();
    });

    it('queries with scarID and year', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        await getCourtDate(doc({ scarID: '1234/2024', year: 2024 }));
        expect(mockSQL).toHaveBeenCalledWith(expect.any(String), ['1234/2024', 2024]);
    });
});

// ─── notifyResults ────────────────────────────────────────────────────────────

describe('notifyResults — recipients', () => {
    it('on success, sends only to negotiator email', async () => {
        mockGetUserDetails.mockResolvedValueOnce({ email: 'neg@aventine.ai', slackID: 'U123', fullName: 'Alice', id: 5 } as any);
        process.env.NOTIFY_RECIPIENTS = 'ops@aventine.ai';

        await notifyResults('5 Uploaded', [doc()], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.emailAddresses).toEqual(['neg@aventine.ai']);
        expect(msg.emailAddresses).not.toContain('ops@aventine.ai');
    });

    it('on error, includes NOTIFY_RECIPIENTS + negotiator', async () => {
        mockGetUserDetails.mockResolvedValueOnce({ email: 'neg@aventine.ai', slackID: 'U123', fullName: 'Alice', id: 5 } as any);
        process.env.NOTIFY_RECIPIENTS = 'ops@aventine.ai';

        await notifyResults('1 Failed', [doc()], doc(), undefined, false, true);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.emailAddresses).toContain('ops@aventine.ai');
        expect(msg.emailAddresses).toContain('neg@aventine.ai');
    });

    it('in testing mode, overrides recipients to catherine@aventine.ai', async () => {
        await notifyResults('3 Uploaded', [doc()], undefined, undefined, true, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.emailAddresses).toEqual(['catherine@aventine.ai']);
    });

    it('in testing mode, clears slackRecipients', async () => {
        await notifyResults('3 Uploaded', [doc()], undefined, undefined, true, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.slackChannel).toEqual([]);
    });
});

describe('notifyResults — subject', () => {
    it('contains ✅ on success', async () => {
        await notifyResults('5 Uploaded', [doc()], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('✅');
    });

    it('contains ❌ on error', async () => {
        await notifyResults('1 Failed', [doc()], doc(), undefined, false, true);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('❌');
    });

    it('includes county code from municode', async () => {
        await notifyResults('1 Uploaded', [doc({ municode: 'SUF' })], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('SUF');
    });

    it('includes "Stipulation" for stip-only docs', async () => {
        await notifyResults('1 Uploaded', [doc({ type: DocumentType.STIPULATION })], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('Stipulation');
    });

    it('includes "Evidence" when any doc is EVIDENCE type', async () => {
        await notifyResults('1 Uploaded', [doc({ type: DocumentType.EVIDENCE })], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('Evidence');
    });

    it('includes "Letter" for a MISC doc with the LETTER identifier', async () => {
        await notifyResults('1 Uploaded', [doc({ type: DocumentType.MISC, identifier: 'LETTER' })], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('Letter');
    });

    it('includes "Letter" for the legacy lower-case letter identifier', async () => {
        await notifyResults('1 Uploaded', [doc({ type: DocumentType.MISC, identifier: 'letter' })], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('Letter');
    });

    it('says "Exhibit", not "Letter", for a MISC doc filed as an exhibit', async () => {
        await notifyResults('1 Uploaded', [doc({ type: DocumentType.MISC, identifier: 'EXHIBIT' })], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('Exhibit');
        expect(msg.subject).not.toContain('Letter');
    });

    it('says "Exhibit" for an unrecognized misc code (those file as EXHIBIT(S))', async () => {
        await notifyResults('1 Uploaded', [doc({ type: DocumentType.MISC, identifier: 'AFFIDAVIT' })], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('Exhibit');
    });

    it('says "Document" for a mixed batch of letters and exhibits', async () => {
        const docs = [doc({ type: DocumentType.MISC, identifier: 'LETTER' }), doc({ type: DocumentType.MISC, identifier: 'EXHIBIT' })];
        await notifyResults('2 Uploaded', docs, undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('Document');
    });

    it('omits the date entirely when none resolves — no "[no date]" placeholder', async () => {
        mockSQL.mockResolvedValue([]);
        await notifyResults('1 Uploaded', [doc()], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).not.toContain('no date');
        expect(msg.subject).not.toContain('[');
    });

    it('includes the court date in brackets when one resolves', async () => {
        mockSQL.mockResolvedValue([{ HearingDate: '2026-03-04' }]);
        await notifyResults('1 Uploaded', [doc()], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('[03-04-2026]');
    });

    it('resolves the court date for MISC docs too, not just evidence', async () => {
        mockSQL.mockResolvedValue([{ HearingDate: '2026-03-04' }]);
        await notifyResults('1 Uploaded', [doc({ type: DocumentType.MISC, identifier: 'EXHIBIT' })], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('[03-04-2026]');
    });

    it('omits the negotiator entirely when none resolves — no "(Unknown)" placeholder', async () => {
        mockGetUserDetails.mockResolvedValue(null);
        await notifyResults('1 Uploaded', [doc()], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).not.toContain('Unknown)');
        expect(msg.subject).not.toContain('(');
    });

    it('includes the negotiator in parens when one resolves', async () => {
        mockGetUserDetails.mockResolvedValue({ fullName: 'Jane Doe', email: 'jane@aventine.ai' } as any);
        await notifyResults('1 Uploaded', [doc()], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('(Jane Doe)');
    });

    it('marks the subject as a test run when testing=true', async () => {
        await notifyResults('1 Uploaded', [doc()], undefined, undefined, true, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toContain('[TEST]');
    });

    it('does not mark the subject when testing=false', async () => {
        await notifyResults('1 Uploaded', [doc()], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).not.toContain('[TEST]');
    });

    it('reads cleanly end-to-end when nothing optional resolves', async () => {
        mockSQL.mockResolvedValue([]);
        mockGetUserDetails.mockResolvedValue(null);
        await notifyResults('1 Uploaded', [doc({ type: DocumentType.MISC, identifier: 'EXHIBIT', municode: 'S08' })], undefined, undefined, true, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.subject).toBe('🧪 [TEST] ⏫ NYSCEF Exhibit Upload for S08 - ✅ 1 Uploaded');
    });
});

describe('notifyResults — body', () => {
    it('includes testing mode banner when testing=true', async () => {
        await notifyResults('3 Uploaded', [doc()], undefined, undefined, true, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.message).toContain('TESTING MODE');
    });

    it('does not include testing mode banner when testing=false', async () => {
        await notifyResults('3 Uploaded', [doc()], undefined, undefined, false, false);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.message).not.toContain('TESTING MODE');
    });
});

// ─── emailSCARClerk ───────────────────────────────────────────────────────────

describe('emailSCARClerk', () => {
    it('returns early when stips array is empty', async () => {
        await emailSCARClerk([], 'from@aventine.ai');
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('returns early when docs are not stipulations', async () => {
        await emailSCARClerk([doc({ type: DocumentType.EVIDENCE })], 'from@aventine.ai');
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('returns early when no stips have been uploaded', async () => {
        await emailSCARClerk([doc({ hasBeenUploaded: false })], 'from@aventine.ai');
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('returns early when no clerkEmail and no realFrom', async () => {
        mockSQL.mockResolvedValueOnce([] as any);
        await emailSCARClerk([doc()], '');
        expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('sends to clerkEmail and realFrom', async () => {
        mockSQL.mockResolvedValueOnce([{ Email: 'clerk@westchester.gov' }] as any);
        await emailSCARClerk([doc()], 'from@aventine.ai');
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.to).toContain('clerk@westchester.gov');
        expect(msg.to).toContain('from@aventine.ai');
    });

    it('ccs negotiator email when negotiator is found', async () => {
        mockSQL.mockResolvedValueOnce([{ Email: 'clerk@westchester.gov' }] as any);
        mockGetUserDetails.mockResolvedValueOnce({ email: 'neg@aventine.ai', slackID: 'U123', fullName: 'Alice', id: 5 } as any);
        await emailSCARClerk([doc()], 'from@aventine.ai');
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.cc).toBe('neg@aventine.ai');
    });

    it('omits cc when negotiator is not found', async () => {
        mockSQL.mockResolvedValueOnce([{ Email: 'clerk@westchester.gov' }] as any);
        mockGetUserDetails.mockResolvedValueOnce(null);
        await emailSCARClerk([doc()], 'from@aventine.ai');
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.cc).toBeUndefined();
    });

    it('in testing mode, sends only to catherine@aventine.ai with no cc', async () => {
        mockSQL.mockResolvedValueOnce([{ Email: 'clerk@westchester.gov' }] as any);
        mockGetUserDetails.mockResolvedValueOnce({ email: 'neg@aventine.ai' } as any);
        await emailSCARClerk([doc()], 'from@aventine.ai', true);
        const msg = mockInvoke.mock.calls[0][1] as any;
        expect(msg.to).toBe('catherine@aventine.ai');
        expect(msg.cc).toBeUndefined();
    });
});
