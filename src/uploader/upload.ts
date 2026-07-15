import { Page } from 'playwright-core';
import { retry } from '../helpers/retry.js';
import { Document, DocumentType } from '../types.js';

const NYSCEF_DOC_TYPES = {
    EVIDENCE_EXHIBIT: 'EXHIBIT(S)',
    STIPULATION_ADJOURNMENT: 'ADJOURNMENT OF CONFERENCE -REQUEST',
    STIPULATION_WITHDRAWAL: 'STIPULATION - OTHER',
    // Nassau and Suffolk both require withdrawals under this NYSCEF doc type.
    WITHDRAWAL_NOTICE: 'NOTICE OF WITHDRAWAL OF SCAR PETITION',
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
            // Nassau & Suffolk: NOTICE OF WITHDRAWAL OF SCAR PETITION (per county filing rules).
            // Other counties: generic STIPULATION - OTHER.
            return nassau || doc.county === 'Suffolk'
                ? NYSCEF_DOC_TYPES.WITHDRAWAL_NOTICE
                : NYSCEF_DOC_TYPES.STIPULATION_WITHDRAWAL;
        default:
            return nassau ? NYSCEF_DOC_TYPES.STIPULATION_NASSAU : NYSCEF_DOC_TYPES.STIPULATION_DEFAULT;
    }
}

// Miscellaneous doc-type code (stored in NyscefUploadQueue.Identifier) -> NYSCEF dropdown label.
// IMPORTANT: keep the key set in sync with MISC_DOC_TYPES in evidence-ingest/src/types.ts.
// The legacy `letter` identifier (lower-case) maps to LETTER via the .toUpperCase() in resolveMiscDocType.
const MISC_CODE_TO_LABEL: Record<string, string> = {
    EXHIBIT: NYSCEF_DOC_TYPES.EVIDENCE_EXHIBIT,
    LETTER: NYSCEF_DOC_TYPES.LETTER,
};

// Resolves a MISC document's NYSCEF label from its identifier code, defaulting to EXHIBIT(S)
// for any code we don't recognize (per product requirement: misc files default to exhibits).
export function resolveMiscDocType(doc: Document): string {
    const code = doc.identifier.trim().toUpperCase();
    const label = MISC_CODE_TO_LABEL[code];
    if (label) return label;

    // A non-empty but unmapped code almost always means the allowlist drifted: someone added a code
    // to MISC_DOC_TYPES in evidence-ingest without adding it to MISC_CODE_TO_LABEL here. We still
    // default to EXHIBIT(S) rather than failing the filing, but say so loudly — otherwise the
    // document is filed with the court under the wrong type with no signal at all.
    if (code !== '') {
        console.warn(
            `⚠️ Unmapped misc doc-type code '${code}' for ParcelID ${doc.parcelID} — filing as ` +
                `${NYSCEF_DOC_TYPES.EVIDENCE_EXHIBIT}. Add it to MISC_CODE_TO_LABEL (upload.ts) to keep it ` +
                `in sync with MISC_DOC_TYPES in evidence-ingest/src/types.ts.`
        );
    }
    return NYSCEF_DOC_TYPES.EVIDENCE_EXHIBIT;
}

// Files the document as an EXHIBIT(S): scrapes existing exhibits to pick the next letter (A, B, C…),
// selects the exhibit doc type, and fills the exhibit-letter + description fields. Shared by the
// EVIDENCE path (description from the report type) and the MISC-as-exhibit path (caller description).
async function selectExhibitDocType(page: Page, doc: Document, description: string): Promise<void> {
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
    const maxCharCode = existingExhibits.length > 0 ? existingExhibits.map((l) => l.charCodeAt(0)).reduce((a, b) => Math.max(a, b)) : 'A'.charCodeAt(0) - 1;
    if (maxCharCode >= 'Z'.charCodeAt(0)) {
        throw new Error(`Exhibit letters exhausted (A-Z) for scarID: ${doc.scarID}`);
    }
    const nextExhibitLetter = String.fromCharCode(maxCharCode + 1);
    console.log(`Next exhibit letter to use: ${nextExhibitLetter}`);

    page.on('dialog', async (dialog) => {
        console.log('Dialog message:', dialog.message());
        await dialog.accept();
    });
    await retry(async () => {
        await page.selectOption('#selDocType_main_1', { label: NYSCEF_DOC_TYPES.EVIDENCE_EXHIBIT });
        await page.fill('#txtExhNumLet_1', nextExhibitLetter);
        await page.fill('#txtDocDes_1', description);
    }, 'Error selecting exhibit document type');
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
            const exhibit = doc.identifier.toLowerCase() === 'excessive' ? EXHIBIT.EXCESSIVE : EXHIBIT.UNEQUAL;
            await selectExhibitDocType(page, doc, exhibit.description);
        } else if (doc.type === DocumentType.STIPULATION) {
            console.log(`Selecting stipulation document type...`);
            await retry(async () => {
                await page.selectOption('#selDocType_main_1', { label: getStipDocType(doc) });
            }, 'Error selecting document type for stipulation');
        } else if (doc.type === DocumentType.MISC) {
            const miscLabel = resolveMiscDocType(doc);
            console.log(`Selecting miscellaneous document type: ${miscLabel}`);
            if (miscLabel === NYSCEF_DOC_TYPES.EVIDENCE_EXHIBIT) {
                // Misc files default to EXHIBIT(S) — reuse the exhibit-numbering path with the
                // caller-supplied description (fall back to a generic label if none provided).
                await selectExhibitDocType(page, doc, doc.description?.trim() || 'Exhibit');
            } else {
                await retry(async () => {
                    await page.selectOption('#selDocType_main_1', { label: miscLabel });
                }, 'Error selecting document type for miscellaneous document');
            }
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
            // Clicking Next submits the multi-MB PDF; the POST + navigation routinely
            // exceeds the 5s default nav timeout, so give this submit a real budget.
            await page.click('#btnNext', { timeout: 60000 });
        }, 'Error uploading document file');

        // submit filing
        console.log(`Submitting filing...`);
        await retry(async () => {
            await page.check('#cbFilingAffir');
            if (testing) {
                console.log('Testing mode enabled - skipping final submission.');
            } else {
                await page.click('#btnSubmit', { timeout: 60000 });
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
