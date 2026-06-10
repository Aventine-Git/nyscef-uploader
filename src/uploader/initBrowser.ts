import chromium from '@sparticuz/chromium';
import { readFileSync } from 'fs';
import type { ChromiumBrowser } from 'playwright-core';
import { chromium as playwright } from 'playwright-extra';
import { fileURLToPath } from 'url';
import { getSecret, updateSecret } from '@shared/secrets.js';

// Keep UA version in sync with the actual @sparticuz/chromium binary version.
// @sparticuz/chromium uses the Chromium major version as its own semver major (e.g. 141.0.0 = Chromium 141).
// A mismatch between the TLS fingerprint and the declared UA is a strong Cloudflare bot signal.
// Note: readFileSync bypasses the package's `exports` field (createRequire/import would throw ERR_PACKAGE_PATH_NOT_EXPORTED).
const chromiumPkgPath = fileURLToPath(new URL('../../node_modules/@sparticuz/chromium/package.json', import.meta.url));
const { version: chromiumPkgVersion } = JSON.parse(readFileSync(chromiumPkgPath, 'utf-8')) as { version: string };
const chromiumMajor = chromiumPkgVersion.split('.')[0]; // "141"
const CHROME_USER_AGENT = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumMajor}.0.0.0 Safari/537.36`;

// Cached per container — the browser is kept warm across invocations (see uploader.ts),
// so this only runs on cold start. Secret format: { "cf_clearance": "<value>" }
let cachedCfCookie: string | null = null;

export function bustCfCookieCache(): void {
    cachedCfCookie = null;
}

// Called after a successful login to keep Secrets Manager current. With a fixed outbound
// IP (NAT Gateway + EIP), this cookie will be valid for the next cold start, avoiding
// Cloudflare challenges on every container spin-up. Failures are non-fatal — the upload
// already succeeded; the worst case is the next cold start faces the challenge again.
export async function saveCfCookie(value: string): Promise<void> {
    cachedCfCookie = value;
    try {
        await updateSecret('nyscef/cf_clearance', { cf_clearance: value });
        console.log('Persisted fresh cf_clearance to Secrets Manager');
    } catch (err) {
        console.warn('Failed to persist cf_clearance to Secrets Manager (non-fatal):', err);
    }
}

// Called when a 403 is received with CF_INJECT_COOKIE=true — the stored cookie is stale for
// this IP. Evict it so the next cold start arrives clean; injecting a wrong-IP cookie
// provokes a harder challenge than no cookie at all.
export async function clearCfCookie(): Promise<void> {
    cachedCfCookie = null;
    try {
        await updateSecret('nyscef/cf_clearance', { cf_clearance: '' });
        console.log('Cleared stale cf_clearance from Secrets Manager');
    } catch (err) {
        console.warn('Failed to clear cf_clearance from Secrets Manager (non-fatal):', err);
    }
}

async function getCfCookie(): Promise<string> {
    if (cachedCfCookie) return cachedCfCookie;

    // Retry Secrets Manager a few times — on Lambda cold start the network interface
    // may not be fully initialized when this first runs, causing a spurious timeout.
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const secret = await getSecret<{ cf_clearance: string }>('nyscef/cf_clearance');
            if (secret.cf_clearance) {
                cachedCfCookie = secret.cf_clearance;
                console.log(`Loaded cf_clearance from Secrets Manager (attempt ${attempt})`);
                return cachedCfCookie;
            }
            break; // secret exists but no cf_clearance field — don't retry
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (attempt < 3) {
                console.warn(`Secrets Manager fetch attempt ${attempt}/3 failed (${msg}) — retrying in 1s`);
                await new Promise((res) => global.setTimeout(res, 1000));
            }
        }
    }

    const fallback = process.env.CF_COOKIE || '';
    if (!fallback) {
        console.warn('cf_clearance cookie is empty — Cloudflare may challenge this browser session');
    }
    return fallback;
}

export async function initBrowser(): Promise<{ browser: ChromiumBrowser; context: any }> {
    let browser: ChromiumBrowser | undefined = undefined;
    const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    console.log('Running in AWS Lambda:', isLambda);

    if (isLambda) {
        chromium.setGraphicsMode = false; // Disable GPU

        browser = await playwright.launch({
            args: [...chromium.args, '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote', '--disable-setuid-sandbox'],
            executablePath: await chromium.executablePath(),
            headless: true,
        });
    } else {
        browser = await playwright.launch({ headless: true });
    }

    const context = await browser.newContext({
        userAgent: CHROME_USER_AGENT,
        viewport: { width: 1920, height: 1080 },
        ...(process.env.PROXY_URL ? { proxy: { server: process.env.PROXY_URL } } : {}),
    });

    // Only inject the stored cf_clearance cookie if CF_INJECT_COOKIE=true is set in the
    // Lambda env. This is only safe when all Lambda containers share a fixed outbound IP
    // (e.g. VPC + NAT Gateway + Elastic IP) — a cookie issued to one IP is rejected on any
    // other, which provokes a harder 403 than arriving with none.
    if (process.env.CF_INJECT_COOKIE === 'true') {
        const cfCookie = await getCfCookie();
        if (cfCookie) {
            await context.addCookies([
                {
                    name: 'cf_clearance',
                    value: cfCookie,
                    domain: '.iapps.courts.state.ny.us',
                    path: '/',
                },
            ]);
            console.log('Injected cf_clearance cookie');
        } else {
            console.log('cf_clearance is empty — arriving clean for this cold start');
        }
    } else {
        console.log('Skipping cf_clearance injection — arriving clean (set CF_INJECT_COOKIE=true to re-enable)');
    }

    return { browser, context };
}
