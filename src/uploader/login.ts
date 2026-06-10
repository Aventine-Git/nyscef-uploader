import { Page } from 'playwright-core';
import { bustCfCookieCache, clearCfCookie } from './initBrowser.js';
import { CloudflareBlockError } from '../errors.js';

export async function login(page: Page) {
    // Brief pause before the first navigation. Cloudflare rate-limits rapid new browser
    // sessions from Lambda IPs — a small delay avoids the challenge on the first attempt.
    await new Promise((res) => global.setTimeout(res, 3000));

    console.log('Logging into NYSCEF...');
    const gotoResponse = await page.goto('https://iapps.courts.state.ny.us/nyscef/Login', {
        waitUntil: 'domcontentloaded',
    });
    const status = gotoResponse?.status();
    console.log(`Login page response: status=${status}, url=${page.url()}`);

    // Detect a Cloudflare challenge/block. Two shapes seen in the wild:
    //   - redirect to a challenge URL (__cf_chl / /cdn-cgi/)
    //   - challenge/block served INLINE at the login URL (URL unchanged) with a 403 or 503
    // Stealth avoids *triggering* challenges but cannot reliably *solve* a managed (403)
    // challenge once presented, and camping on the challenge page does NOT turn it into
    // the login form — a rate-limit challenge clears by backing off and re-requesting with
    // a fresh session (addBrowser's retry loop), not by waiting here. So fail FAST and let
    // that loop run; long dwells just burn the Lambda's time budget and the IP's reputation.
    const challengeUrl = page.url().includes('__cf_chl') || page.url().includes('/cdn-cgi/');

    // 503 = legacy "checking your browser" interstitial, which DOES auto-solve in-browser.
    // Arriving without a cookie (the default now), this is our primary success path, so
    // give it a realistic window: cold-start Lambda CPU is throttled, so the challenge JS
    // can take well over 8s to run, submit, and re-render the real login form.
    if (status === 503 && !challengeUrl) {
        console.log('Cloudflare 503 interstitial — waiting for it to auto-solve...');
        const cleared = await page
            .waitForSelector('#txtUserName', { state: 'visible', timeout: 12000 })
            .then(() => true)
            .catch(() => false);
        if (!cleared) {
            bustCfCookieCache();
            throw new CloudflareBlockError(`Cloudflare 503 interstitial not cleared (status=${status}, url=${page.url()}) — cf_clearance cookie missing or IP-mismatched for this Lambda container`);
        }
    } else if (challengeUrl || status === 403) {
        // Managed challenge / hard block — not solvable in-browser. Bust the cache so the
        // next init re-fetches the cookie (in case it was rotated externally) and throw
        // CloudflareBlockError (noRetry=true) so all retry loops bail immediately rather than
        // hammering Cloudflare's rate limiter. SQS visibility timeout provides the delay.
        bustCfCookieCache();
        // If we injected a stored cookie and still got 403, the cookie is stale for this IP.
        // Evict it from Secrets Manager immediately so the next cold start arrives clean —
        // re-injecting a dead cookie provokes a harder challenge than no cookie at all.
        if (process.env.CF_INJECT_COOKIE === 'true') {
            void clearCfCookie();
        }
        throw new CloudflareBlockError(`Cloudflare challenge (status=${status}, url=${page.url()}) — cf_clearance cookie missing or IP-mismatched for this Lambda container`);
    }

    await page.fill('#txtUserName', process.env.NYSCEF_USERNAME || '');
    await page.fill('#pwPassword', process.env.NYSCEF_PASSWORD || '');
    await page.click('#btnLogin');

    // Wait for navigation and check for password reset redirect
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    const currentUrl = page.url();

    if (currentUrl.includes('/sspr/')) {
        throw new Error('NYSCEF password needs to be reset. Please reset your password at the NYSCEF portal.');
    }

    if (currentUrl !== 'https://iapps.courts.state.ny.us/nyscef/SupremeHome') {
        throw new Error(`Login failed - unexpected URL: ${currentUrl}`);
    }

    console.log('Successfully logged into NYSCEF');
}
