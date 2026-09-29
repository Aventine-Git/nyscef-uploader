export type CloudflareBlockKind = 'EGRESS_DENIED' | 'CHALLENGE' | 'UNKNOWN';

// Both shapes arrive as HTTP 403, so the status code cannot tell them apart — only the body can.
// EGRESS_DENIED means Cloudflare is refusing this outbound IP: no cookie and no retry will help,
// and clearing cf_clearance on it destroys a valid cookie (2026-09-10, incidents #1920/#1921).
// Deny is tested first because that page embeds a /cdn-cgi/ email-protection link of its own.
const DENY_MARKERS = /Request Could Not Be Processed|please try disabling your VPN/i;
const CHALLENGE_MARKERS = /Just a moment|Enable JavaScript and cookies|__cf_chl/i;

export function classifyCloudflareBlock(body: string): CloudflareBlockKind {
    if (DENY_MARKERS.test(body)) return 'EGRESS_DENIED';
    if (CHALLENGE_MARKERS.test(body)) return 'CHALLENGE';
    return 'UNKNOWN';
}
