import { invokeLambda } from '../shared_helpers/lambda.js';
import { getUserByEmail, getUserDetails } from '../shared_helpers/sql.js';
import { User, NotifierMsg } from '../shared_helpers/types.js';
import { findFirstValidCountyCode } from '../helpers/countyCode.js';
import { findFirstValidNegotiatorID } from '../helpers/negotiator.js';
import { uploadScreenshotToS3 } from '../helpers/screenshot.js';
import { formatDataTable } from './formatDataTable.js';
import { Document, describeUploadType } from '../types.js';
import getCourtDate from './getCourtDate.js';
import { reportIncident } from '../shared_helpers/reporter.js';

/**
 * The always-available email fallback. Tolerates a NOTIFY_RECIPIENTS that is set but
 * blank/comma-only — an env var that parses to zero addresses is the same failure as an
 * unset one, and the message still has to reach somebody.
 */
function resolveDefaultRecipients(): string[] {
    const configured = envList('NOTIFY_RECIPIENTS');
    return configured.length > 0 ? configured : ['catherine@aventine.ai'];
}

/** Comma-separated env var → trimmed, non-empty entries. */
function envList(name: string): string[] {
    const raw: string = process.env[name] || '';
    return raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

/** Unique, non-empty values, in the order given: the notifier posts once per entry, so a repeated
 *  recipient — the uploader who is also the case negotiator — would get two of the same message. */
function uniqueRecipients(values: (string | null | undefined)[]): string[] {
    const present = values.map((value) => value?.trim()).filter((value): value is string => !!value);
    return [...new Set(present)];
}

/**
 * The person who asked for this filing. `realFrom` is an audit-trail field, so it holds whatever
 * the caller sent: an address for a human-initiated upload, but a script name for the scheduled
 * ones ("Motions To Preclude Upload Script"). Only an address can be matched to an account, and a
 * failed lookup must not sink the notification, so anything else resolves to null.
 */
async function resolveUploader(realFrom: string): Promise<User | null> {
    const candidate = realFrom.trim();
    if (!candidate.includes('@')) return null;
    try {
        return await getUserByEmail(candidate);
    } catch (err: unknown) {
        console.warn(`Could not resolve uploader ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

export async function notifyResults(
    result: string,
    documents: Document[],
    failedDoc?: Document,
    screenshot?: Buffer,
    testing: boolean = false,
    isError: boolean = false,
    wasRetried: boolean = false,
    realFrom: string = ''
) {
    const negotiatorID = findFirstValidNegotiatorID(documents);
    let negotiator: User | null = null;
    if (negotiatorID !== null) {
        negotiator = await getUserDetails(negotiatorID);
    }

    const uploader = await resolveUploader(realFrom);

    const municode = findFirstValidCountyCode(documents);
    const countyCode = municode ? municode : 'Unknown County';
    const uploadType = describeUploadType(documents);
    const isSuccess = failedDoc === undefined && !isError;

    // Resolved for every document type, not just evidence — getCourtDate keys off scarID + year,
    // which every Document has, and misc/stipulation filings sit on dated cases too. A failure here
    // must not sink the notification itself, so it degrades to "no date known".
    let courtDate: string | null = null;
    if (documents.length > 0) {
        try {
            courtDate = await getCourtDate(documents[0]);
        } catch (err: unknown) {
            console.warn(`Could not resolve court date for ${documents[0].scarID}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    let recipients: string[];
    let slackRecipients: string[];

    if (isSuccess) {
        // Success: notify whoever asked for the filing, then the case negotiator. Slack is DM-only
        // — with nobody resolved we send no Slack rather than falling back to a shared channel,
        // which is what made every exhibit upload (queued with no NegotiatorID) channel noise.
        // If this was a retry, also notify default recipients so they see the resolution
        // after receiving the earlier failure notification.
        recipients = uniqueRecipients([uploader?.email, negotiator?.email]);
        slackRecipients = uniqueRecipients([uploader?.slackID, negotiator?.slackID]);
        if (wasRetried) {
            recipients = uniqueRecipients([...resolveDefaultRecipients(), ...recipients]);
            slackRecipients = uniqueRecipients([...envList('NOTIFY_SLACK_RECIPIENTS'), ...slackRecipients]);
        }
    } else {
        // Error: notify default recipients + uploader + negotiator
        recipients = uniqueRecipients([...resolveDefaultRecipients(), uploader?.email, negotiator?.email]);
        slackRecipients = uniqueRecipients([...envList('NOTIFY_SLACK_RECIPIENTS'), uploader?.slackID, negotiator?.slackID]);
    }

    if (testing) {
        console.log('Testing mode enabled - overriding notification recipients.');
        recipients = ['catherine@aventine.ai'];
        slackRecipients = []; // its messaged to me anyways
    }

    // Slack is optional (an empty list means no DM). Email is not: SES rejects an empty To
    // header with a 400 that surfaced as a MAJOR incident for an upload that had gone through.
    // Never hand the notifier an empty email list.
    if (recipients.length === 0) {
        console.warn('No uploader or negotiator email resolved for this upload - falling back to default notification recipients.');
        recipients = resolveDefaultRecipients();
    }

    const negotiatorName = negotiator?.fullName ?? null;
    const status = isSuccess ? '✅' : '❌';

    // Assembled from optional parts so an unresolved date or negotiator drops out of the subject
    // entirely. Rendering them as "[no date]" and "(Unknown)" read like data we had failed to look
    // up, when usually there simply is none — noise that made real lookup failures invisible.
    const subject = [
        testing ? '🧪 [TEST]' : null,
        `⏫ NYSCEF ${uploadType} Upload for`,
        courtDate ? `[${courtDate}]` : null,
        countyCode,
        negotiatorName ? `(${negotiatorName})` : null,
        `- ${status} ${result}`,
    ]
        .filter((part): part is string => part !== null)
        .join(' ');

    let body = `
    <h2>${uploadType} Ingest Notification for ${countyCode}</h2>
    `;
    if (negotiatorName) {
        body += `
    <div style="background-color:#f8d7da;border:1px solid #f5c6cb;border-radius:4px;padding:12px;margin:12px 0;">
        <strong style="font-size:18px;">Negotiator: ${negotiatorName}</strong>
    </div>
    `;
    }
    if (testing) {
        body = `<h3 style="color:#e67e22;">⚠️ TESTING MODE - NO DATABASE CHANGES MADE ⚠️</h3>` + body;
    }

    if (failedDoc !== undefined) {
        body += `<p><strong>Failed ${uploadType} Details:</strong></p>`;
        body += formatDataTable([failedDoc]);
        const failureIndex = documents.indexOf(failedDoc);
        const successfulDocs = documents.slice(0, failureIndex);
        if (successfulDocs.length > 0) {
            body += `<h4>Successful ${uploadType}s Before Failure:</h4>`;
            body += formatDataTable(successfulDocs);
        }
    } else {
        body += formatDataTable(documents);
    }

    const humphreymsg: NotifierMsg = {
        subject: subject,
        message: body,
        slackChannel: [...slackRecipients].filter((id): id is string => !!id),
        emailAddresses: recipients,
        screenshotUrl: screenshot ? await uploadScreenshotToS3(screenshot) : undefined,
        hasHtmlReport: true,
    };

    try {
        const res = await invokeLambda('notifier', humphreymsg);
        console.log('Notification sent successfully:', res);
        return res;
    } catch (error) {
        console.error('Error sending notification:', error);
        reportIncident('nyscef-uploader', 'notifyResults', 'major', `Failed to send upload notification: ${error instanceof Error ? error.message : String(error)}`).catch(console.error);
    }
}
