import type { ChromiumBrowser, Cookie } from 'playwright-core'; // Only for type checking
import { initBrowser, saveCfCookie } from './initBrowser.js';
import { login } from './login.js';
import { cleanupTmpProfiles } from './cleanupTmp.js';
import { CloudflareBlockError } from '../errors.js';

const MAX_BROWSER_ATTEMPTS = 5;

export async function addBrowser(browsers: ChromiumBrowser[]): Promise<any> {
    let lastError: any;

    // Reclaim any browser profile dirs leaked by prior failed inits before we start
    // launching — otherwise a /tmp that's already full crashes every attempt below.
    cleanupTmpProfiles();

    for (let attempt = 1; attempt <= MAX_BROWSER_ATTEMPTS; attempt++) {
        let browser: ChromiumBrowser | undefined;
        try {
            const result = await initBrowser();
            browser = result.browser;
            const context = result.context;

            const loginPage = await context.newPage();
            loginPage.setDefaultTimeout(15000);
            loginPage.setDefaultNavigationTimeout(45000);

            await login(loginPage);

            // Only persist the cookie when injection is enabled (i.e. a fixed outbound IP
            // exists). Without a fixed IP the stored value would be IP-mismatched on the next
            // cold start and injecting it would make things worse, not better.
            if (process.env.CF_INJECT_COOKIE === 'true') {
                const cookies = await context.cookies('https://iapps.courts.state.ny.us');
                const cfCookie = cookies.find((c: Cookie) => c.name === 'cf_clearance');
                if (cfCookie) void saveCfCookie(cfCookie.value);
            }

            await loginPage.close();

            browsers.push(browser);
            return context;
        } catch (error) {
            if (error instanceof CloudflareBlockError) throw error; // don't retry CF hard blocks
            lastError = error;
            console.warn(`Browser init attempt ${attempt}/${MAX_BROWSER_ATTEMPTS} failed.`, error);
            if (browser) {
                try {
                    await browser.close();
                } catch {
                    /* ignore */
                }
            }
            // This attempt's profile dir likely leaked (it crashed/failed) — reclaim it
            // now so retries don't compound /tmp pressure. No browser is active here.
            cleanupTmpProfiles();
            if (attempt < MAX_BROWSER_ATTEMPTS) {
                // Exponential backoff: 3s, 6s, 12s, 24s
                // Gives Cloudflare's rate-limit window time to reset between attempts.
                const delay = 3000 * Math.pow(2, attempt - 1);
                console.log(`Waiting ${delay / 1000}s before attempt ${attempt + 1}...`);
                await new Promise((res) => global.setTimeout(res, delay));
            }
        }
    }

    throw lastError;
}
