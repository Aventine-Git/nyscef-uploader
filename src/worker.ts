import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { processSQSRecords, retryFailedItems } from './queue/queueProcessor.js';
import { testLogin } from './uploader.js';
import { reportStatus } from './shared_helpers/reporter.js';
import { isInCooldown, cooldownRemainingMs } from './helpers/cfCooldown.js';
import dotenv from 'dotenv';
dotenv.config();

const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const QUEUE_URL = process.env.NYSCEF_QUEUE_URL!;
const RETRY_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes — matches the EventBridge schedule
const WORKER_NAME = 'nyscef-uploader-worker';

let isShuttingDown = false;

async function pollSQS(): Promise<void> {
    console.log(`[worker] SQS poll loop started. Queue: ${QUEUE_URL}`);
    while (!isShuttingDown) {
        // Cloudflare cooldown: don't pull new messages while uploads are paused — leaving them
        // in the queue (undelivered, not failed) means they keep their full retry budget until
        // the block clears. Cap the sleep so shutdown stays responsive and we re-check the window.
        if (isInCooldown()) {
            const remaining = cooldownRemainingMs();
            const waitMs = Math.min(remaining, 30000);
            console.log(`[worker] Cloudflare cooldown active — pausing SQS consumption (${Math.round(remaining / 1000)}s remaining).`);
            await new Promise((res) => global.setTimeout(res, waitMs));
            continue;
        }
        try {
            const response = await sqs.send(
                new ReceiveMessageCommand({
                    QueueUrl: QUEUE_URL,
                    WaitTimeSeconds: 20, // long polling — avoids hammering SQS
                    MaxNumberOfMessages: 1,
                })
            );

            if (!response.Messages?.length) continue;

            for (const message of response.Messages) {
                if (isShuttingDown) break;
                console.log(`[worker] Received SQS message ${message.MessageId}`);
                try {
                    // processSQSRecords expects the Lambda Records format: [{ body: string }]
                    await processSQSRecords([{ body: message.Body }]);
                    // Only delete after successful processing.
                    // On failure we do NOT delete — the message returns to queue after
                    // the visibility timeout, giving it another chance (same behavior as Lambda).
                    await sqs.send(
                        new DeleteMessageCommand({
                            QueueUrl: QUEUE_URL,
                            ReceiptHandle: message.ReceiptHandle!,
                        })
                    );
                    console.log(`[worker] Deleted message ${message.MessageId}`);
                } catch (err: any) {
                    console.error(`[worker] Failed to process message ${message.MessageId}:`, err.message);
                }
            }
        } catch (err: any) {
            if (isShuttingDown) break;
            console.error('[worker] SQS receive error:', err.message);
            await new Promise((res) => global.setTimeout(res, 5000));
        }
    }
    console.log('[worker] Poll loop exited.');
}

function startRetryScheduler(): void {
    const run = async () => {
        if (isShuttingDown) return;
        // Skip the retry sweep during a Cloudflare cooldown — re-running failed items now would
        // just burn their remaining attempts against the same block. The next tick picks them up.
        if (isInCooldown()) {
            console.log(`[worker] Cloudflare cooldown active — skipping scheduled retry (${Math.round(cooldownRemainingMs() / 1000)}s remaining).`);
            return;
        }
        console.log('[worker] Running scheduled retry of failed items...');
        try {
            await retryFailedItems();
        } catch (err: any) {
            console.error('[worker] Retry scheduler error:', err.message);
        }
    };

    // Run once on startup to catch anything stuck from a previous run, then on interval.
    run();
    const interval = global.setInterval(run, RETRY_INTERVAL_MS);
    process.on('SIGTERM', () => global.clearInterval(interval));
    process.on('SIGINT', () => global.clearInterval(interval));
}

async function main(): Promise<void> {
    if (!QUEUE_URL) {
        console.error('[worker] NYSCEF_QUEUE_URL is not set. Exiting.');
        process.exit(1);
    }

    console.log('[worker] nyscef-uploader worker starting...');

    process.on('SIGTERM', () => {
        console.log('[worker] SIGTERM — shutting down gracefully...');
        isShuttingDown = true;
    });
    process.on('SIGINT', () => {
        console.log('[worker] SIGINT — shutting down gracefully...');
        isShuttingDown = true;
    });

    try {
        await reportStatus(WORKER_NAME, 'healthy', 'Worker starting up');
    } catch {
        // non-fatal — monitoring endpoint may not be reachable yet
    }

    if (process.env.WARM_START_LOGIN === 'true') {
        console.log('[worker] Warming up browser session on startup...');
        try {
            await testLogin();
            console.log('[worker] Browser warm-up successful.');
        } catch (err: any) {
            console.warn('[worker] Browser warm-up failed (will retry on first job):', err.message);
        }
    }

    startRetryScheduler();
    await pollSQS();
}

main().catch((err) => {
    console.error('[worker] Fatal error:', err);
    process.exit(1);
});
