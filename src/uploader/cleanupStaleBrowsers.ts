import type { ChromiumBrowser } from 'playwright-core';

export async function cleanupStaleBrowsers(activeBrowsers: ChromiumBrowser[]) {
    if (activeBrowsers.length > 0) {
        console.log(`🧹 [WARM START] Cleaning up ${activeBrowsers.length} stale browser(s) from previous invocation`);
        for (const browser of activeBrowsers) {
            try {
                await browser.close();
            } catch {
                // already closed, ignore
            }
        }
        activeBrowsers = [];
    }
}
