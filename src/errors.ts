// noRetry: bust all retry loops immediately — hammering Cloudflare's rate limiter makes it worse.
// Incident reporting is suppressed on non-final attempts by processItem in queueProcessor.ts,
// which applies uniformly to all error types based on the Attempts column.
export class CloudflareBlockError extends Error {
    readonly noRetry = true;
    constructor(message: string) {
        super(message);
        this.name = 'CloudflareBlockError';
    }
}

// Raised when NYSCEF explicitly rejected the filing (validation banner, document checker refusal).
// The submit button was pressed and the court said no, so nothing is on the docket and a retry is
// pointless until the underlying document changes — hence noRetry.
export class RejectedSubmissionError extends Error {
    readonly noRetry = true;
    constructor(message: string) {
        super(message);
        this.name = 'RejectedSubmissionError';
    }
}

// Raised when we pressed submit but could not determine from the resulting page whether NYSCEF
// accepted the filing. This is the dangerous case: the document may or may not be on the docket.
// It must never be retried automatically — a blind re-file duplicates a real court filing — so it
// carries noRetry and queueProcessor routes it to NEEDS_REVIEW for a human to check the docket.
export class UnverifiedSubmissionError extends Error {
    readonly noRetry = true;
    readonly needsReview = true;
    constructor(message: string) {
        super(message);
        this.name = 'UnverifiedSubmissionError';
    }
}
