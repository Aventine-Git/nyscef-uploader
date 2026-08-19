import { describe, it, expect } from 'vitest';
import { verifySubmission } from '../../src/uploader/verifySubmission.js';

// Minimal Page stand-in: verifySubmission only touches waitForLoadState and two locators.
function fakePage(opts: { bodyText?: string; bodyThrows?: boolean; submitVisible?: boolean; loadStateThrows?: boolean }) {
    return {
        waitForLoadState: async () => {
            if (opts.loadStateThrows) throw new Error('networkidle timeout');
        },
        locator: (selector: string) => {
            if (selector === 'body') {
                return {
                    innerText: async () => {
                        if (opts.bodyThrows) throw new Error('no body');
                        return opts.bodyText ?? '';
                    },
                };
            }
            if (selector === '#btnSubmit') {
                return { isVisible: async () => opts.submitVisible ?? false };
            }
            throw new Error(`unexpected selector: ${selector}`);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

describe('verifySubmission', () => {
    it('confirms when the page carries a confirmation notice', async () => {
        const verdict = await verifySubmission(fakePage({ bodyText: 'Your documents have been received. Confirmation Notice' }));
        expect(verdict.status).toBe('CONFIRMED');
    });

    it('extracts the NYSCEF document number as the confirmation reference', async () => {
        const verdict = await verifySubmission(fakePage({ bodyText: 'Filing Receipt — NYSCEF Doc No. 14 has been received.' }));
        expect(verdict.status).toBe('CONFIRMED');
        expect(verdict.confirmationRef).toBe('14');
    });

    it('confirms without a reference when the page exposes none', async () => {
        const verdict = await verifySubmission(fakePage({ bodyText: 'Successfully filed.' }));
        expect(verdict.status).toBe('CONFIRMED');
        expect(verdict.confirmationRef).toBeUndefined();
    });

    it('rejects when the document checker refuses the PDF', async () => {
        const verdict = await verifySubmission(fakePage({ bodyText: 'Document checker failed: invalid PDF.' }));
        expect(verdict.status).toBe('REJECTED');
    });

    // A NYSCEF page can carry boilerplate confirmation wording alongside a specific error banner.
    // The error has to win, or a refused filing records as a successful one — the original bug.
    it('prefers rejection when both confirmation and error text are present', async () => {
        const verdict = await verifySubmission(
            fakePage({ bodyText: 'Confirmation Notice. Please correct the following errors before continuing.' })
        );
        expect(verdict.status).toBe('REJECTED');
    });

    it('rejects when still sitting on the review form', async () => {
        const verdict = await verifySubmission(fakePage({ bodyText: 'Review your filing', submitVisible: true }));
        expect(verdict.status).toBe('REJECTED');
        expect(verdict.detail).toMatch(/review form/i);
    });

    // The case the whole module exists for: submit was pressed, the outcome is unreadable. It must
    // not collapse into CONFIRMED (hides a lost filing) or REJECTED (triggers a duplicate re-file).
    it('returns UNKNOWN when the page matches nothing recognizable', async () => {
        const verdict = await verifySubmission(fakePage({ bodyText: 'Session expired. Please log in again.' }));
        expect(verdict.status).toBe('UNKNOWN');
    });

    it('returns UNKNOWN when the page body cannot be read at all', async () => {
        const verdict = await verifySubmission(fakePage({ bodyThrows: true }));
        expect(verdict.status).toBe('UNKNOWN');
    });

    // A networkidle timeout is common on multi-MB filings and is not itself a verdict — whatever
    // rendered still gets inspected.
    it('still inspects the page after a load-state timeout', async () => {
        const verdict = await verifySubmission(fakePage({ loadStateThrows: true, bodyText: 'Confirmation Notice' }));
        expect(verdict.status).toBe('CONFIRMED');
    });

    it('captures a page excerpt for diagnosis on non-confirmed verdicts', async () => {
        const verdict = await verifySubmission(fakePage({ bodyText: 'Something   entirely \n unexpected' }));
        expect(verdict.status).toBe('UNKNOWN');
        expect(verdict.pageExcerpt).toBe('Something entirely unexpected');
    });
});
