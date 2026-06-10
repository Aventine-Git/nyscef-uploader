import { test } from '@playwright/test';
import { handler } from '../src/index.js';

// ─── Configure your test here ────────────────────────────────────────────────

// Set to the NyscefUploadQueue ID you want to process (must have Testing=1 in DB).
// Insert a row manually, then paste the ID here before running.
const QUEUE_ITEM_ID = 0; // <-- replace with a real ID

// ─────────────────────────────────────────────────────────────────────────────

function makeSQSEvent(id: number) {
    return {
        Records: [
            {
                eventSource: 'aws:sqs',
                body: JSON.stringify({ id }),
            },
        ],
    };
}

test.describe('NYSCEF Queue Processor', () => {
    // test('Process a single queue item by ID (SQS path)', async () => {
    //     test.setTimeout(60000 * 5); // 5 minutes

    //     if (!QUEUE_ITEM_ID) {
    //         console.warn('QUEUE_ITEM_ID is not set — skipping test. Set it at the top of this file.');
    //         test.skip();
    //     }

    //     console.log(`Processing queue item ID=${QUEUE_ITEM_ID} via simulated SQS event...`);
    //     const event = makeSQSEvent(QUEUE_ITEM_ID);
    //     const result = await handler(event);
    //     console.log('Handler result:', result);
    // });

    // test('Retry all failed queue items (EventBridge path)', async () => {
    //     test.setTimeout(60000 * 10); // 10 minutes

    //     // Triggers the same code path as the EventBridge scheduled rule.
    //     // Will pick up any rows in Court.NyscefUploadQueue with Status='FAILED'
    //     // and Attempts < MAX_ATTEMPTS (3). Safe to run — only Testing=1 rows
    //     // will skip the final NYSCEF submit button.
    //     console.log('Triggering retry of failed queue items via simulated EventBridge event...');
    //     const event = {}; // no Records array → falls through to retryFailedItems()
    //     const result = await handler(event);
    //     console.log('Handler result:', result);
    // });

    test('Force-retry all pending queue items (QUEUED + FAILED, any attempt count)', async () => {
        test.setTimeout(0); // no timeout — let it run as long as it needs

        // Triggers forceRetryAllItems() — picks up every row in Court.NyscefUploadQueue
        // with Status IN ('QUEUED', 'FAILED'), ordered by Attempts ASC so fresher items
        // go first. claimQueueItem sets Status=PROCESSING immediately, so the live Lambda
        // (SQS / EventBridge) cannot double-process any item we've already claimed.
        console.log('Triggering force-retry of all pending queue items...');
        const event = { forceRetry: true };
        const result = await handler(event);
        console.log('Handler result:', result);
    });
});
