import { invokeLambda } from '@shared/lambda.js';
import { getUserDetails } from '@shared/sql.js';
import { getClerkEmail } from './getClerkEmail.js';
import { Document, DocumentType } from '../types.js';
import { GmailMsg } from '@shared/types.js';
import { putS3 } from '@shared/s3.js';
import { mergePDFBuffers } from '../helpers/buffer.js';
import { findFirstValidNegotiatorID } from '../helpers/negotiator.js';

export async function emailSCARClerk(stips: Document[], realFrom: string, testing: boolean = false) {
    if (stips.length === 0) {
        console.log('No stipulations provided for emailing SCAR clerk. Exiting function.');
        return;
    }
    if (stips[0].type !== DocumentType.STIPULATION) {
        console.log('Provided documents are not stipulations. Exiting function.');
        return;
    }
    const subject = 'Countersigned Stipulations Uploaded to Nyscef';
    const htmlBody = `
    <h2>Hello,</h2>
    <p>Please find attached the countersigned stipulations for your review and processing. These have all been uploaded to NYSCEF.</p>
    `;
    const footer = `
    <p>If you have any questions or require further information, please do not hesitate to contact us.</p>
    <p>Best regards,<br/>The Aventine Team</p>
    `;

    const uploadedStips = stips.filter((stip) => stip.hasBeenUploaded);
    if (uploadedStips.length === 0) {
        console.log('No stipulations were uploaded successfully. Skipping email to SCAR clerk.');
        return;
    }
    const county = uploadedStips[0].county;
    const [clerkEmail, negotiator] = await Promise.all([
        getClerkEmail(county),
        (async () => {
            const id = findFirstValidNegotiatorID(uploadedStips);
            return id !== null ? getUserDetails(id) : null;
        })(),
    ]);
    if (!clerkEmail && !realFrom) {
        console.warn(`No SCAR clerk or assessor email found for county: ${county}. Skipping email notification.`);
        return;
    }
    const negotiatorEmail = negotiator?.email ?? undefined;

    // scarID list
    const scarIDs = `
    <br/><h3>UPLOADED SCAR IDs:</h3>
    <ul>
        ${uploadedStips.map((stip) => `<li>${stip.scarID}</li>`).join('\n')}
    </ul>
`;
    // create combined buffer link
    const buffersToMerge = uploadedStips.map((stip) => stip.docBuffer!).filter((buf): buf is Buffer => !!buf);
    const merged = await mergePDFBuffers(buffersToMerge);
    const combinedKey = `combined_stipulations/combined_stipulations_${Date.now()}.pdf`;
    await putS3('stipulation-ingest-files', combinedKey, merged, 'combined_stipulations.pdf', 'application/pdf');
    const combinedBufferLink = `https://stipulation-ingest-files.s3.us-east-1.amazonaws.com/${combinedKey}`;

    const link = `<br/><br/>You can download the combined stipulations here: <a href="${combinedBufferLink}">Download Stipulations</a><br/><br/>`;

    // send email
    const gmailMsg: GmailMsg = {
        to: testing ? 'catherine@aventine.ai' : [clerkEmail, realFrom].filter((email): email is string => !!email),
        cc: testing ? undefined : negotiatorEmail,
        subject: subject,
        body: htmlBody + scarIDs + link + footer,
        from: process.env.STIPULATIONS_EMAIL_USER!,
    };

    try {
        const res = await invokeLambda('gmail-sender', gmailMsg);
        console.log(`Clerk email sent to ${testing ? 'catherine@aventine.ai' : `${clerkEmail} and ${realFrom} `}`, res);
    } catch (error) {
        console.error('Error sending clerk email:', error);
    }
}
