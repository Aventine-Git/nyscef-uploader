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
