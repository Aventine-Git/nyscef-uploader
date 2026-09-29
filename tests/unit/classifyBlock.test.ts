import { describe, it, expect } from 'vitest';

import { classifyCloudflareBlock } from '../../src/uploader/classifyBlock.ts';

// Both pages are HTTP 403 and the deny page carries its own /cdn-cgi/ link, so a marker check can mix
// them up: a deny read as a challenge wiped a valid cookie on 2026-09-10; the reverse stops evicting a stale one.
describe('classifyCloudflareBlock', () => {
    it('classifies the NYCourts deny page as a denied egress', () => {
        const denyPage = `<html><head><title>Request Could Not Be Processed</title></head><body>
            <h1>Request Could Not Be Processed</h1>
            <p>If you are accessing our website using a VPN, please try disabling your VPN and accessing our site again.</p>
            <div class="rayid">a38eee1e1cb4de99</div>
            <a class="button" href="/cdn-cgi/l/email-protection#55223037263036153b2c363a2027">send an email to support</a>
            </body></html>`;

        expect(classifyCloudflareBlock(denyPage)).toBe('EGRESS_DENIED');
    });

    it('classifies the interstitial as a solvable challenge', () => {
        const interstitial = '<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>';

        expect(classifyCloudflareBlock(interstitial)).toBe('CHALLENGE');
    });
});
