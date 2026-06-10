export interface NotifierMsg {
    slackChannel?: string | string[];
    emailAddresses?: string | string[];
    subject: string;
    message: string;
    attachmentKeys?: string | string[];
    screenshotUrl?: string;
    hasHtmlReport?: boolean;
    slackMessage?: string;
}

export type GmailMsg = {
    to: string | string[];
    from: string;
    cc?: string | string[];
    subject: string;
    body?: string;
    templateData?: Record<string, any>;
    templateName?: string;
    attachments?: { filename: string; content: Buffer | string; contentType?: string }[];
    attachmentsKeys?: string | string[];
    queueId?: number;
    emailType?: string;
    requestId?: number;
};

export enum IngestItemStatus {
    QUEUED = 'Queued',
    SKIPPED = 'Skipped',
    INVALID = 'Invalid',
    FAILED = 'Failed',
    UPDATED = 'Updated',
    INSERTED = 'Inserted',
    UPLOADED = 'Uploaded',
    UPLOADING = 'Uploading',
}

export enum IngestItemType {
    NEGOTIATION = 'Negotiation',
    STIPULATION = 'Stipulation',
    SALES_EVIDENCE = 'SalesEvidence',
    EQUITY_EVIDENCE = 'EquityEvidence',
    OTHER_EVIDENCE = 'OtherEvidence',
}

export interface User {
    userId: number;
    fullName: string;
    firstName: string;
    lastName: string;
    slackID: string;
    email: string;
}
