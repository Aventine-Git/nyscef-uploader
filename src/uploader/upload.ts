import { Page } from 'playwright-core';
import { retry } from '../helpers/retry.js';
import { Document, DocumentType, ExhibitLabelMode } from '../types.js';
import { getNyscefFilerName } from './credentials.js';

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

// The NY convention (expressly adopted by many judges' individual rules) is that petitioner exhibits
// are NUMBERED and respondent exhibits are LETTERED, and we file as the petitioner. We nonetheless
// default to LETTER: it is the firm's established house style, and NUMBER remains available as a
// per-filing override for the judges who ask for it.
const DEFAULT_EXHIBIT_LABEL_MODE: ExhibitLabelMode = 'LETTER';

// One row of the case's document table, as scraped from the NYSCEF DocumentList.
export interface ScrapedExhibit {
    label: string; // the exhibit number/letter, e.g. '1' or 'A'
    filerName: string; // the "Filed By" cell's display name, '' if absent
}

/**
 * Picks the label for the exhibit we're about to file.
 *
 * `ourExistingLabels` must already be filtered to exhibits WE filed — the opposing party's
 * exhibits neither select the mode nor advance the counter. Each side numbers/letters
 * independently, so it is expected and correct that our "Exhibit 1" can coexist on the docket
 * with the assessor's "Exhibit 1".
 *
 * Mode resolution: explicit override > continuity with our own prior filings > default.
 * The continuity rule keeps a case internally consistent: if we already filed exhibits in one
 * style, stay in it rather than producing a mixed A, B, 1 sequence mid-case — whichever direction
 * the default later moves. Only a case with no prior exhibits of ours (or a mix of both styles,
 * which shouldn't happen) falls through to the default.
 */
export function computeNextExhibitLabel(ourExistingLabels: string[], override: ExhibitLabelMode | null, scarID: string): string {
    const letters = ourExistingLabels.filter((l) => /^[A-Z]$/.test(l));
    const numbers = ourExistingLabels.filter((l) => /^\d+$/.test(l)).map(Number);

    let continuity: ExhibitLabelMode | null = null;
    if (letters.length > 0 && numbers.length === 0) continuity = 'LETTER';
    else if (numbers.length > 0 && letters.length === 0) continuity = 'NUMBER';

    const mode = override ?? continuity ?? DEFAULT_EXHIBIT_LABEL_MODE;

    if (mode === 'LETTER') {
        // max+1 rather than first-free: gaps are left alone, matching long-standing behavior.
        const maxCharCode = letters.length > 0 ? Math.max(...letters.map((l) => l.charCodeAt(0))) : 'A'.charCodeAt(0) - 1;
        if (maxCharCode >= 'Z'.charCodeAt(0)) {
            throw new Error(`Exhibit letters exhausted (A-Z) for scarID: ${scarID}`);
        }
        return String.fromCharCode(maxCharCode + 1);
    }

    // Numbers have no ceiling, so there is no exhaustion case to guard.
    return String(numbers.length > 0 ? Math.max(...numbers) + 1 : 1);
}

/**
 * Scrapes every EXHIBIT(S) row on the case, capturing each one's label AND its filer.
 *
 * MUST be called while on the DocumentList page. The filing form ("Add Documents") mentions
 * EXHIBIT(S) only as <option> text in the doc-type dropdown — it carries no filed-document rows and
 * no "Filed By" cells — so scraping there silently yields nothing. (That was the original bug: the
 * scrape ran after navigating to the filing form, always came back empty, and every exhibit was
 * therefore filed as "A".)
 *
 * The "Filed By" cell is the third column of the same <tr>, so this needs no extra page load.
 */
export async function scrapeExistingExhibits(page: Page): Promise<ScrapedExhibit[]> {
    return page.$$eval('a', (links) => {
        return links
            .filter((link) => link.textContent?.includes('EXHIBIT(S)'))
            .map((link) => {
                const row = link.closest('tr');
                const rowText = row?.textContent ?? link.parentElement?.textContent ?? '';
                const match = rowText.match(/EXHIBIT\(S\)[\s\S]*?-\s*([A-Z]|\d+)\b/);
                if (!match) return null;
                const filerLink = row?.querySelector('a[href*="FilingUserInfo"]');
                return { label: match[1], filerName: filerLink?.textContent?.trim() ?? '' };
            })
            .filter((e): e is { label: string; filerName: string } => e !== null);
    });
}

// Narrows scraped exhibits to the ones WE filed. Attribution is by filer display name: the row's
// filerId is re-encrypted per docket, so it is useless as a stable identity. If no filer name is
// configured (or it matches nothing) we treat NO rows as ours and fall through to the plain default
// — failing open to numbering is the safe direction now that numbering is the convention.
export function filterToOurExhibits(scraped: ScrapedExhibit[], ourFilerName: string): string[] {
    if (!ourFilerName) {
        console.warn(`⚠️ No filerName configured in the nyscef/credentials secret — cannot tell our exhibits from the opposing party's. Defaulting to ${DEFAULT_EXHIBIT_LABEL_MODE} labeling.`);
        return [];
    }
    const ours = scraped.filter((e) => e.filerName.toLowerCase() === ourFilerName.toLowerCase());
    if (scraped.length > 0 && ours.length === 0) {
        console.warn(`⚠️ ${scraped.length} exhibit(s) on this case, none filed by '${ourFilerName}'. If that is wrong, the configured filerName does not match NYSCEF's "Filed By" text.`);
    }
    console.log(`Existing exhibits for this case: ${ours.length} ours (${ours.map((e) => e.label).join(', ') || 'none'}) of ${scraped.length} total`);
    return ours.map((e) => e.label);
}

// Files the document as an EXHIBIT(S): picks the next label (1, 2, 3… by default) from the exhibits
// scraped off the DocumentList earlier in the flow, selects the exhibit doc type, and fills the
// exhibit-number + description fields. Shared by the EVIDENCE path (description from the report
// type) and the MISC-as-exhibit path (caller description).
async function selectExhibitDocType(page: Page, doc: Document, description: string, existingExhibits: ScrapedExhibit[]): Promise<void> {
    const ourLabels = filterToOurExhibits(existingExhibits, await getNyscefFilerName());
    const nextExhibitLabel = computeNextExhibitLabel(ourLabels, doc.exhibitLabelMode, doc.scarID);
    console.log(`Next exhibit label to use: ${nextExhibitLabel}`);

    page.on('dialog', async (dialog) => {
        console.log('Dialog message:', dialog.message());
        await dialog.accept();
    });
    await retry(async () => {
        await page.selectOption('#selDocType_main_1', { label: NYSCEF_DOC_TYPES.EVIDENCE_EXHIBIT });
        await page.fill('#txtExhNumLet_1', nextExhibitLabel);
        await page.fill('#txtDocDes_1', description);
    }, 'Error selecting exhibit document type');
}

// Fills the description box (#txtDocDes_1 — labeled "Additional Document Information" on the LETTER
// form) for a doc type that is selected on its own, without the exhibit-numbering path.
//
// Best-effort by design: a description is optional metadata, so if the selected doc type does not
// render the field we log and move on rather than failing an otherwise-valid court filing. The
// exhibit path fills the same element unconditionally because it is always present there.
export async function fillOptionalDescription(page: Page, doc: Document): Promise<void> {
    const description = doc.description?.trim();
    if (!description) return;

    const descField = page.locator('#txtDocDes_1');
    if ((await descField.count()) === 0) {
        console.warn(`Description provided for ParcelID ${doc.parcelID}, but no #txtDocDes_1 field on this form — skipping.`);
        return;
    }

    await retry(async () => {
        await descField.fill(description);
    }, 'Error filling additional document information');
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

        // Capture existing exhibits BEFORE leaving the DocumentList — the filing form has no
        // filed-document rows, so this is the only page where they can be read.
        const existingExhibits = await scrapeExistingExhibits(page);

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
            await selectExhibitDocType(page, doc, exhibit.description, existingExhibits);
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
                await selectExhibitDocType(page, doc, doc.description?.trim() || 'Exhibit', existingExhibits);
            } else {
                await retry(async () => {
                    await page.selectOption('#selDocType_main_1', { label: miscLabel });
                }, 'Error selecting document type for miscellaneous document');
                // The LETTER form renders an "Additional Document Information" box, which is the same
                // #txtDocDes_1 element the exhibit form uses for its description (NYSCEF reuses one form
                // template and relabels the fields per doc type). Fill it best-effort: set it when a
                // caller supplied a description, but never fail the filing if some doc type does not
                // render the field.
                await fillOptionalDescription(page, doc);
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
