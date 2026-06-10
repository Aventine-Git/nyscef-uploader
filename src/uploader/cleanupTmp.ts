import { readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Chromium (via Playwright) creates a fresh profile dir under /tmp on every launch, e.g.
//   /tmp/playwright_chromiumdev_profile-XXXXXX
// browser.close() normally removes it — but when the browser CRASHES on launch (Lambda
// /tmp exhaustion, --single-process renderer death, OOM), the dir leaks. Across a warm
// container's many retry-heavy invocations these pile up until /tmp hits 0 bytes free, at
// which point Chromium can no longer allocate shared-memory files (we route them to /tmp
// via --disable-dev-shm-usage) and every subsequent launch dies with
// "Target page, context or browser has been closed".
//
// Prefixes target ONLY per-launch leak dirs — never /tmp/chromium (the extracted binary),
// so we don't force a slow re-extraction on the next launch.
const LEAK_PREFIXES = ['playwright_', '.org.chromium.Chromium.', '.com.google.Chrome.'];

/**
 * Sweep leaked Chromium/Playwright temp dirs from /tmp. Safe to call only when NO browser
 * is active in this container (cold init / between failed retry attempts): Lambda runs one
 * invocation per container at a time, so there is never a concurrent browser to clobber.
 */
export function cleanupTmpProfiles(): void {
    const dir = tmpdir();
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }

    let removed = 0;
    for (const name of entries) {
        if (!LEAK_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
        try {
            rmSync(join(dir, name), { recursive: true, force: true });
            removed++;
        } catch {
            // in use or already gone — ignore
        }
    }
    if (removed > 0) console.log(`🧹 Swept ${removed} stale Chromium temp dir(s) from ${dir}`);
}
