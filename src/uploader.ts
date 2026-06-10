import type { ChromiumBrowser, Page } from 'playwright-core'; // Only for type checking
import { chromium as playwright } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { Document, DocumentType } from './types.js';
import { executeSQLQuery } from '@shared/sql.js';
import * as tracker from '@shared/ingestTracking.js';
import { IngestItemStatus, IngestItemType } from '@shared/types.js';
import dotenv from 'dotenv';
import { retry } from './helpers/retry.js';
import { addBrowser } from './uploader/addBrowser.js';
import { CloudflareBlockError } from './errors.js';
import { cleanupStaleBrowsers } from './uploader/cleanupStaleBrowsers.js';
import { upload } from './uploader/upload.js';
import { checkAlreadyUploaded } from './uploader/checkAlreadyUploaded.js';
import { tryScreenshot } from './helpers/screenshot.js';
dotenv.config();

// Register stealth plugin once at module level (runs once per Lambda container)
playwright.use(stealth());

// Track browsers AND context at module level so warm starts can reuse an existing
// NYSCEF session rather than logging in (and triggering Cloudflare) on every invocation.
let activeBrowsers: ChromiumBrowser[] = [];
let activeContext: Awaited<ReturnType<typeof addBrowser>> | undefined = undefined;

// Returns an existing browser context if the browser is still connected,
// otherwise cleans up and creates a fresh one (with full Cloudflare login).
async function getContext(): Promise<Awaited<ReturnType<typeof addBrowser>>> {
    if (activeBrowsers.length > 0 && activeBrowsers[0].isConnected() && activeContext) {
        console.log('♻️ [WARM BROWSER] Reusing existing NYSCEF session — skipping login');
        return activeContext;
    }

    // Browser is gone or never created — clean up any stale references and start fresh
    await cleanupStaleBrowsers(activeBrowsers);
    const browsers: ChromiumBrowser[] = [];
    activeBrowsers = browsers;
    const context = await addBrowser(browsers);
    activeContext = context;
    return context;
}

async function initPage(context: { newPage(): Promise<Page> }): Promise<Page> {
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(5000);
    return page;
}

function getIngestItemType(doc: Document): IngestItemType {
    if (doc.type === DocumentType.STIPULATION) return IngestItemType.STIPULATION;
    if (doc.identifier.toLowerCase() === 'unequal') return IngestItemType.SALES_EVIDENCE;
    if (doc.identifier.toLowerCase() === 'excessive') return IngestItemType.EQUITY_EVIDENCE;
    return IngestItemType.OTHER_EVIDENCE;
}

async function trackDocStatus(ingestID: number | undefined, doc: Document, itemType: IngestItemType, status: IngestItemStatus, message: string): Promise<void> {
    if (ingestID) await tracker.updateIngestItemStatus(ingestID, doc.parcelID, itemType, status, message);
}

export async function testLogin(): Promise<void> {
    await cleanupStaleBrowsers(activeBrowsers);
    const browsers: ChromiumBrowser[] = [];
    activeBrowsers = browsers;
    const context = await addBrowser(browsers);
    activeContext = context;
    console.log('🧪 Login test successful — browser context is warm and ready');
}

export async function uploadToNyscef(documents: Document[], testing: boolean = false, ingestID: number | undefined, realFrom: string): Promise<Document[]> {
    console.log(
        'Starting upload to NYSCEF for documents:',
        documents.map((s) => s.parcelID)
    );
    if (documents.length === 0) {
        console.log('No documents to upload. Exiting upload process.');
        return documents;
    }

    try {
        let context = await getContext();

        // process each document
        let page: Page | undefined = undefined;
        for (const doc of documents) {
            page = await initPage(context);
            if (!page) throw new Error('Failed to create new page for upload.');

            const ingestItemType = getIngestItemType(doc);
            await trackDocStatus(ingestID, doc, ingestItemType, IngestItemStatus.UPLOADING, 'Uploading document to NYSCEF');

            console.log(`Uploading document for ParcelID: ${doc.parcelID}, ScarID: ${doc.scarID}`);
            let lastScreenshot: Buffer | undefined;
            try {
                // Check if document has already been uploaded
                if (!doc.forceUpload && await checkAlreadyUploaded(doc, realFrom)) {
                    doc.hasBeenUploaded = true;
                    doc.wasSkipped = true;
                    await trackDocStatus(ingestID, doc, ingestItemType, IngestItemStatus.SKIPPED, 'Document already uploaded to NYSCEF');
                    continue;
                }
                console.log(`Proceeding with upload for ParcelID: ${doc.parcelID}`);

                if (!page) throw new Error('Page is not initialized.');
                if (!context) throw new Error('Browser context is not initialized.');
                if (activeBrowsers.length === 0) throw new Error('No browsers available.');

                // upload to nyscef
                await retry(async () => {
                    try {
                        await upload(page!, doc, testing);
                    } catch (error: any) {
                        // Cloudflare hard block — don't close/re-login, that only compounds the
                        // rate-limit storm. Propagate immediately; SQS visibility timeout handles delay.
                        if (error instanceof CloudflareBlockError) throw error;
                        // session expired or browser crashed — take screenshot, close all old browsers,
                        // then launch a fresh single browser before retrying
                        console.warn('Error during upload, re-initializing browser and re-logging in.', error);
                        lastScreenshot = await tryScreenshot(page!);

                        // close all existing browsers before launching a new one to avoid OOM
                        for (const b of activeBrowsers) {
                            try {
                                await b.close();
                            } catch {
                                /* ignore */
                            }
                        }
                        activeBrowsers.length = 0;
                        activeContext = undefined;

                        context = await addBrowser(activeBrowsers);
                        activeContext = context;
                        page = await initPage(context);
                        throw error; // trigger retry with fresh page
                    }
                }, `Error uploading document for ParcelID: ${doc.parcelID}`);
                console.log(`Upload successful for ParcelID: ${doc.parcelID}`);

                await page.close();

                // update database status
                console.log(`✅ [DB UPDATE] Document ParcelID: ${doc.parcelID} NYSCEF Upload Status: ${doc.hasBeenUploaded}`);
                if (doc.hasBeenUploaded) {
                    await trackDocStatus(ingestID, doc, ingestItemType, IngestItemStatus.UPLOADED, 'Document successfully uploaded to NYSCEF');
                    if (testing) {
                        console.log(`⚠️ [TESTING MODE] Skipping DB update for ParcelID: ${doc.parcelID} due to testing mode.`);
                        continue;
                    }
                    if (doc.type === DocumentType.STIPULATION) {
                        const updateQuery = `UPDATE StipTracking SET Status = 'NyscefUploaded', LastUpdateDate = NOW() WHERE ParcelID = ? AND Year = ?`;
                        await executeSQLQuery(updateQuery, [doc.parcelID, doc.year]);
                    } else if (doc.type === DocumentType.EVIDENCE) {
                        const updateQuery = `INSERT Into Court.UploadedEvidence (ParcelID, Year, SCARIndexNumber, Evidence, UploadDate)
                     VALUES (?, ?, ?, JSON_ARRAY(?), NOW())
                     ON DUPLICATE KEY UPDATE
                       UploadDate = NOW(),
                       Evidence = JSON_ARRAY_APPEND(Evidence, '$', ?)`;
                        const capitalizedIdentifier = doc.identifier.charAt(0).toUpperCase() + doc.identifier.slice(1);
                        await executeSQLQuery(updateQuery, [doc.parcelID, doc.year, doc.scarID, capitalizedIdentifier, capitalizedIdentifier]);
                    } else if (doc.type === DocumentType.MISC) {
                        const updateQuery = `INSERT INTO Court.UploadedLetters (ParcelID, Year, SCARIndexNumber, UploadDate)
                     VALUES (?, ?, ?, NOW())
                     ON DUPLICATE KEY UPDATE UploadDate = NOW()`;
                        await executeSQLQuery(updateQuery, [doc.parcelID, doc.year, doc.scarID]);
                    }
                }
            } catch (error: any) {
                console.error(`Upload failed for ParcelID: ${doc.parcelID}:`, error);
                await trackDocStatus(ingestID, doc, ingestItemType, IngestItemStatus.FAILED, `Upload failed: ${error.message}`);
                error.failedDoc = doc;
                error.screenshot = lastScreenshot ?? (await tryScreenshot(page));
                if (page) await page.close();
                throw error;
            }
        }
    } catch (error) {
        console.error('Error uploading to NYSCEF:', error);
        // On unrecoverable error, close the browser so the next invocation starts fresh
        // rather than reusing a potentially broken session.
        for (const browser of activeBrowsers) {
            try { await browser.close(); } catch { /* ignore */ }
        }
        activeBrowsers = [];
        activeContext = undefined;
        throw error;
    }

    console.log('All documents processed.');
    return documents;
}
