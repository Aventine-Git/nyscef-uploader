import { invokeLambda } from '../shared_helpers/lambda.js';
import { getUserDetails } from '../shared_helpers/sql.js';
import { User, NotifierMsg } from '../shared_helpers/types.js';
import { findFirstValidCountyCode } from '../helpers/countyCode.js';
import { findFirstValidNegotiatorID } from '../helpers/negotiator.js';
import { uploadScreenshotToS3 } from '../helpers/screenshot.js';
import { formatDataTable } from './formatDataTable.js';
import { Document, describeUploadType } from '../types.js';
import getCourtDate from './getCourtDate.js';
import { reportIncident } from '../shared_helpers/reporter.js';

export async function notifyResults(result: string, documents: Document[], failedDoc?: Document, screenshot?: Buffer, testing: boolean = false, isError: boolean = false, wasRetried: boolean = false) {
    const negotiatorID = findFirstValidNegotiatorID(documents);
    let negotiator: User | null = null;
    if (negotiatorID !== null) {
        negotiator = await getUserDetails(negotiatorID);
    }

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
    const genericChannel = 'C082FUMUCJ1';

    if (isSuccess) {
        // Success: notify negotiator; if this was a retry, also notify default recipients so
        // they see the resolution after receiving the earlier failure notification.
        recipients = negotiator?.email ? [negotiator.email] : [];
        slackRecipients = negotiator?.slackID ? [negotiator.slackID] : [genericChannel];
        if (wasRetried) {
            const defaultRecipients = (process.env.NOTIFY_RECIPIENTS || 'catherine@aventine.ai').split(',').map((e) => e.trim());
            recipients = [...new Set([...defaultRecipients, ...recipients])];
            const defaultSlack = (process.env.NOTIFY_SLACK_RECIPIENTS || '').split(',').map((id) => id.trim()).filter((id) => id.length > 0);
            slackRecipients = [...new Set([...defaultSlack, ...slackRecipients])];
        }
    } else {
        // Error: notify default recipients + negotiator
        recipients = (process.env.NOTIFY_RECIPIENTS || 'catherine@aventine.ai').split(',').map((email) => email.trim());
        slackRecipients = (process.env.NOTIFY_SLACK_RECIPIENTS || '')
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0);
        if (negotiator?.email) recipients.push(negotiator.email);
        if (negotiator?.slackID) slackRecipients.push(negotiator.slackID);
    }

    if (testing) {
        console.log('Testing mode enabled - overriding notification recipients.');
        recipients = ['catherine@aventine.ai'];
        slackRecipients = []; // its messaged to me anyways
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
