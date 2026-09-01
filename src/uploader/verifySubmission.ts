import { Page } from 'playwright-core';

// Post-submit verification.
//
// Before this existed, upload.ts clicked #btnSubmit, slept 2s, and set hasBeenUploaded = true
// unconditionally — so a filing NYSCEF rejected still recorded as UPLOADED, and the queue's
// Status column could not distinguish "on the docket" from "we pressed a button". Everything
// downstream (StipTracking, the run report, the ingest audit trail) inherited that guess.
//
// The verdict is deliberately three-valued. CONFIRMED and REJECTED are both actionable; UNKNOWN
// is the one that matters most, because "we submitted and don't know what happened" must not be
// collapsed into either. Collapsing it into failure causes an automatic re-file of a document
// that may already be with the court; collapsing it into success hides a lost filing.

export type SubmissionStatus = 'CONFIRMED' | 'REJECTED' | 'UNKNOWN';

export interface SubmissionVerdict {
    status: SubmissionStatus;
    /** Human-readable reason, safe to store in NyscefUploadQueue.ErrorMessage. */
    detail: string;
    /** NYSCEF document/confirmation reference, when the page exposes one. */
    confirmationRef?: string;
    /** Trimmed page text at verification time — captured for diagnosis on REJECTED/UNKNOWN. */
    pageExcerpt?: string;
}

// Text that only appears once NYSCEF has taken the filing. These were derived from the filing
// flow's confirmation step; if NYSCEF rewords its confirmation page, verification degrades to
// UNKNOWN (safe) rather than to a false CONFIRMED, and the excerpt captured on UNKNOWN is what
// you use to re-tune this list.
const CONFIRMATION_PATTERNS: RegExp[] = [
    /confirmation\s+notice/i,
    /document(s)?\s+(have\s+been\s+)?received/i,
    /filing\s+receipt/i,
    /nyscef\s+doc(ument)?\s*(no|#)/i,
    /successfully\s+(filed|submitted)/i,
];

// Text that means NYSCEF refused the filing. The document-checker refusal is the one that has
// actually been biting: it rejects PDFs written with PDF 1.5+ cross-reference/object streams.
const REJECTION_PATTERNS: RegExp[] = [
    /document\s+(checker|validation)\s+(failed|error)/i,
    /invalid\s+(pdf|document|file)/i,
    /(pdf|file)\s+(is\s+)?(corrupt|damaged|not\s+valid)/i,
    /could\s+not\s+(be\s+)?process(ed)?/i,
    /please\s+correct\s+the\s+following/i,
    /the\s+following\s+error/i,
];

// Reference formats NYSCEF shows on the confirmation step.
// Group 1 must be the reference itself — every other group here is non-capturing on purpose.
//
// `no\b`, not `no`: NYSCEF's confirmation page is headed "Confirmation Notice", and an unbounded
// `no` matched the "No" inside "Notice" and captured the "tice" after it — every filing in the
// 2026-08-25 logs reported `ref tice`. The boundary still matches the abbreviation in "No." and
// "No:" but never the start of a longer word.
const CONFIRMATION_REF_PATTERNS: RegExp[] = [/nyscef\s+doc(?:ument)?\s*(?:no\b|#)\.?\s*:?\s*(\d+)/i, /confirmation\s*(?:no\b|#)\.?\s*:?\s*([\w-]+)/i];

/**
 * Decide whether NYSCEF accepted the filing we just submitted.
 *
 * Never throws on a missing selector or a slow page — an inconclusive read returns UNKNOWN so the
 * caller can fail closed. The only thing that would make this return CONFIRMED is positive
 * evidence on the page.
 */
export async function verifySubmission(page: Page): Promise<SubmissionVerdict> {
    // Wait for the post-submit navigation to settle. `networkidle` rather than a fixed sleep: the
    // filing POST carries a multi-MB PDF and the court's response time varies by minutes-of-day.
    // A timeout here is not itself a failure — the checks below still run against whatever
    // rendered — so it is swallowed rather than propagated.
    try {
        await page.waitForLoadState('networkidle', { timeout: 45000 });
    } catch {
        // fall through to inspection; the page may be usable even if some asset never settled
    }

    let bodyText = '';
    try {
        bodyText = (await page.locator('body').innerText({ timeout: 10000 })) ?? '';
    } catch {
        return {
            status: 'UNKNOWN',
            detail: 'Submit was pressed but the resulting page could not be read (body never rendered).',
        };
    }

    const excerpt = bodyText.replace(/\s+/g, ' ').trim().slice(0, 1500);

    // Rejection is checked first. A page can legitimately carry both a boilerplate confirmation
    // heading and a specific error banner; when both are present the error is the operative one.
    const rejection = REJECTION_PATTERNS.find((re) => re.test(bodyText));
    if (rejection) {
        return {
            status: 'REJECTED',
            detail: `NYSCEF rejected the filing (matched ${rejection}).`,
            pageExcerpt: excerpt,
        };
    }

    const confirmation = CONFIRMATION_PATTERNS.find((re) => re.test(bodyText));
    if (confirmation) {
        let confirmationRef: string | undefined;
        for (const re of CONFIRMATION_REF_PATTERNS) {
            const match = bodyText.match(re);
            if (match?.[1]) {
                confirmationRef = match[1];
                break;
            }
        }
        return {
            status: 'CONFIRMED',
            detail: confirmationRef ? `NYSCEF confirmed the filing (ref ${confirmationRef}).` : 'NYSCEF confirmed the filing.',
            confirmationRef,
        };
    }

    // No verdict from the page text. Still sitting on the review form is a strong signal the
    // submission never went through at all — the court has nothing, so this is a clean failure
    // rather than an ambiguous one, and it is safe to retry.
    const stillOnReviewForm = await page
        .locator('#btnSubmit')
        .isVisible()
        .catch(() => false);
    if (stillOnReviewForm) {
        return {
            status: 'REJECTED',
            detail: 'Still on the review form after submit — the filing was not accepted.',
            pageExcerpt: excerpt,
        };
    }

    return {
        status: 'UNKNOWN',
        detail: 'Submit was pressed but the resulting page matched no known confirmation or error text. The document may or may not be on the docket — check NYSCEF before re-filing.',
        pageExcerpt: excerpt,
    };
}
