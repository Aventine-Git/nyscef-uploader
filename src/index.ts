/* eslint-disable @typescript-eslint/no-explicit-any */
import { processDirectInvocation } from './direct.js';
import { forceRetryAllItems, processSQSRecords, retryFailedItems } from './queue/queueProcessor.js';
import { testLogin } from './uploader.js';
import { EventInput } from './types.js';
import { withErrorReporting } from '@shared/handlerWrapper.js';

async function _handler(event: any): Promise<{ statusCode: number; body: string }> {
    console.log('Handler invoked with event:', JSON.stringify(event, null, 2));
    try {
        if (event.Records?.[0]?.eventSource === 'aws:sqs') {
            // SQS-triggered path
            console.log('📥 SQS event received with', event.Records.length, 'record(s).');
            await processSQSRecords(event.Records);
        } else if (event.requestContext?.httpMethod || event.requestContext?.http?.method) {
            // API Gateway endpoint invocation path
            const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
            console.log('[👵LEGACY] Direct invocation detected with documents:', body.documents.length);
            await processDirectInvocation(body as EventInput);
        } else if (event._selfTest === true) {
            // Smoke test ping — just confirms the handler loaded and routed correctly.
            console.log('🧪 Self-test: handler initialised successfully.');
        } else if (event._loginTest === true) {
            // Login test — launches the browser, attempts NYSCEF login, and saves the
            // cf_clearance cookie. Use this to verify VPC + CF_INJECT_COOKIE setup.
            console.log('🧪 Login test: launching browser and testing NYSCEF login...');
            await testLogin();
        } else if (event.forceRetry === true) {
            // Manual force-retry — processes all QUEUED and FAILED items regardless of attempt count
            console.log('🔁 Force-retry trigger detected — retrying all pending items.');
            await forceRetryAllItems();
        } else {
            // Scheduled EventBridge trigger — retrying failed items
            console.log('⏰ Scheduled trigger detected — retrying failed items.');
            await retryFailedItems();
        }
        return { statusCode: 200, body: 'done' };
    } catch (error: any) {
        console.error('Unhandled error in handler:', error);
        throw error;
    }
}

export const handler = withErrorReporting(_handler);
