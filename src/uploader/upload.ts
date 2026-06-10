import { Page } from 'playwright-core';
import { retry } from '../helpers/retry.js';
import { Document, DocumentType } from '../types.js';

const NYSCEF_DOC_TYPES = {
    EVIDENCE_EXHIBIT: 'EXHIBIT(S)',
    STIPULATION_ADJOURNMENT: 'ADJOURNMENT OF CONFERENCE -REQUEST',
    STIPULATION_WITHDRAWAL: 'STIPULATION - OTHER',
    STIPULATION_WITHDRAWAL_NASSAU: 'NOTICE OF WITHDRAWAL OF SCAR PETITION',
    STIPULATION_NASSAU: 'STIPULATION - SETTLEMENT - SCAR PROCEEDING',
    STIPULATION_DEFAULT: 'STIPULATION - OTHER - ( REQUEST TO SO ORDER )',
    LETTER: 'LETTER / CORRESPONDENCE TO JUDGE',
} as const;

const EXHIBIT = {
    UNEQUAL: { description: 'Sales Comp Analysis' },
    EXCESSIVE: { description: 'Adjusted FMV (Assessment Equity) Report' },
} as const;

function getStipDocType(doc: Document): string {
    const nassau = doc.county === 'Nassau';
    switch (doc.identifier) {
        case 'OA':
            return NYSCEF_DOC_TYPES.STIPULATION_ADJOURNMENT;
        case 'W':
            return nassau ? NYSCEF_DOC_TYPES.STIPULATION_WITHDRAWAL_NASSAU : NYSCEF_DOC_TYPES.STIPULATION_WITHDRAWAL;
        default:
            return nassau ? NYSCEF_DOC_TYPES.STIPULATION_NASSAU : NYSCEF_DOC_TYPES.STIPULATION_DEFAULT;
    }
}

export async function upload(page: Page, doc: Document, testing: boolean = false) {
    try {
        // Navigate to the case using stip data
        console.log(`Searching for case file...`);
        await retry(async () => {
            await page.goto('https://iapps.courts.state.ny.us/nyscef/CaseSearch');
            await page.fill('#txtCaseIdentifierNumber', doc.scarID);
            await page.selectOption('#txtCounty', { label: doc.county });
            await page.click('#form button[type="submit"]');
            await page.waitForURL('https://iapps.courts.state.ny.us/nyscef/CaseSearchResults'); // this is captcha protected
        }, 'Error navigating to case search results');

        // now we're in search results, click on the first case's document link
        console.log(`Accessing case page...`);
        await retry(async () => {
            await page.click(`a:text("${doc.scarID}")`);
            await page.waitForURL('**/DocumentList**');
        }, 'Error navigating to case page');

        // find the next evidence exhibit number for this case, starting from A, by looking at existing filings
        const existingExhibits = await page.$$eval('a', (links) => {
            return links
                .filter((link) => link.textContent?.includes('EXHIBIT(S)'))
                .map((link) => {
                    const rowText = link.closest('tr')?.textContent ?? link.parentElement?.textContent ?? '';
                    // skip numbered exhibits (- 1, - 2, etc.)
                    if (/EXHIBIT\(S\)[\s\S]*?-\s*\d/.test(rowText)) return null;
                    const match = rowText.match(/EXHIBIT\(S\)[\s\S]*?-\s*([A-Z])\b/);
                    return match ? match[1] : null;
                })
                .filter((letter): letter is string => letter !== null);
        });
        console.log(`Existing exhibits for this case: ${existingExhibits.join(', ')}`);
        const nextExhibitLetter = existingExhibits.length > 0 ? String.fromCharCode(existingExhibits.map((l) => l.charCodeAt(0)).reduce((a, b) => Math.max(a, b)) + 1) : 'A';
        console.log(`Next exhibit letter to use: ${nextExhibitLetter}`);

        // now we're in the case page, click on "File Document" button
        console.log(`Navigating to filing page...`);
        await retry(async () => {
            await page.click('a:text("File to this Case")');
            await page.waitForURL('**/FindCase?startOfFiling=true**');
        }, 'Error navigating to filing page');

        // now we're in the case
        console.log(`Starting new filing...`);
        await retry(async () => {
            await page.check('#rbNotMotionRelated'); // select "Not Motion Related"
            await page.click('#btnSubmit');
        }, 'Error starting new filing');

        // select document type
        if (doc.type === DocumentType.EVIDENCE) {
            console.log(`Selecting evidence document type...`);
            await retry(async () => {
                page.on('dialog', async (dialog) => {
                    console.log('Dialog message:', dialog.message());
                    await dialog.accept();
                });
                await page.selectOption('#selDocType_main_1', { label: NYSCEF_DOC_TYPES.EVIDENCE_EXHIBIT });
                const exhibit = doc.identifier.toLowerCase() === 'excessive' ? EXHIBIT.EXCESSIVE : EXHIBIT.UNEQUAL;
                await page.fill('#txtExhNumLet_1', nextExhibitLetter);
                await page.fill('#txtDocDes_1', exhibit.description);
            }, 'Error uploading evidence document');
        } else if (doc.type === DocumentType.STIPULATION) {
            console.log(`Selecting stipulation document type...`);
            await retry(async () => {
                await page.selectOption('#selDocType_main_1', { label: getStipDocType(doc) });
            }, 'Error selecting document type for stipulation');
        } else if (doc.type === DocumentType.MISC) {
            console.log(`Selecting miscellaneous document type...`);
            await retry(async () => {
                await page.selectOption('#selDocType_main_1', { label: NYSCEF_DOC_TYPES.LETTER });
            }, 'Error selecting document type for miscellaneous document');
        } else {
            throw new Error('Unknown document type for upload.');
        }

        console.log(`Uploading document file for ParcelID: ${doc.parcelID}...`);
        await retry(async () => {
            await page.setInputFiles('#txtFileName_1', {
                name: `${doc.type.toString().toUpperCase()}_${doc.type === DocumentType.EVIDENCE ? doc.identifier.toUpperCase() : ''}${doc.parcelID}.pdf`,
                mimeType: 'application/pdf',
                buffer: doc.docBuffer,
            });
            await page.waitForTimeout(1000); // wait for upload to register
            await page.click('#btnNext');
        }, 'Error uploading document file');

        // submit filing
        console.log(`Submitting filing...`);
        await retry(async () => {
            await page.check('#cbFilingAffir');
            if (testing) {
                console.log('Testing mode enabled - skipping final submission.');
            } else {
                await page.click('#btnSubmit');
                await page.waitForTimeout(2000);
            }
            doc.hasBeenUploaded = true;
        }, 'Error submitting filing');
    } catch (error) {
        console.error(`Error uploading document for ParcelID: ${doc.parcelID}`, error);
        throw error;
    }

    console.log(`Successfully uploaded document for ParcelID: ${doc.parcelID}`);
}
