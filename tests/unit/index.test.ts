import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shim withErrorReporting — same pattern as other lambdas
vi.mock('../../src/shared_helpers/handlerWrapper.js', () => ({
    withErrorReporting: (fn: (...args: any[]) => Promise<any>) => async (event: any, context: any) => {
        try {
            return await fn(event, context);
        } catch (error: any) {
            return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
        }
    },
}));

vi.mock('../../src/shared_helpers/lambda.js', () => ({
    invokeLambda: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/direct.js', () => ({
    processDirectInvocation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/queue/queueProcessor.js', () => ({
    processSQSRecords: vi.fn().mockResolvedValue(undefined),
    retryFailedItems: vi.fn().mockResolvedValue(undefined),
    forceRetryAllItems: vi.fn().mockResolvedValue(undefined),
}));

// playwright-extra and stealth are imported at module level in uploader.ts
// mock them so the module loads without needing a real browser
vi.mock('playwright-extra', () => ({
    chromium: { use: vi.fn(), launch: vi.fn() },
}));
vi.mock('puppeteer-extra-plugin-stealth', () => ({ default: vi.fn(() => ({})) }));

import { handler } from '../../src/index.ts';
import { processSQSRecords, retryFailedItems, forceRetryAllItems } from '../../src/queue/queueProcessor.js';
import { processDirectInvocation } from '../../src/direct.js';

const mockContext = { functionName: 'nyscef-uploader', logStreamName: 'test-log' };

beforeEach(() => vi.clearAllMocks());

// ─── Routing ──────────────────────────────────────────────────────────────────

describe('handler — routing', () => {
    it('routes SQS events to processSQSRecords', async () => {
        const event = { Records: [{ eventSource: 'aws:sqs', body: '{"id":1}' }] };
        const res = await handler(event, mockContext);
        expect(res.statusCode).toBe(200);
        expect(processSQSRecords).toHaveBeenCalledWith(event.Records);
        expect(retryFailedItems).not.toHaveBeenCalled();
    });

    it('routes API Gateway (httpMethod) events to processDirectInvocation', async () => {
        const event = {
            requestContext: { httpMethod: 'POST' },
            body: JSON.stringify({ documents: [] }),
        };
        const res = await handler(event, mockContext);
        expect(res.statusCode).toBe(200);
        expect(processDirectInvocation).toHaveBeenCalledWith({ documents: [] });
    });

    it('routes API Gateway (http.method) events to processDirectInvocation', async () => {
        const event = {
            requestContext: { http: { method: 'POST' } },
            body: JSON.stringify({ documents: [] }),
        };
        const res = await handler(event, mockContext);
        expect(res.statusCode).toBe(200);
        expect(processDirectInvocation).toHaveBeenCalled();
    });

    it('parses body string for direct invocation', async () => {
        const body = { documents: [{ parcelID: 'WES-001' }] };
        const event = {
            requestContext: { httpMethod: 'POST' },
            body: JSON.stringify(body),
        };
        await handler(event, mockContext);
        expect(processDirectInvocation).toHaveBeenCalledWith(body);
    });

    it('passes forceUpload from body through to processDirectInvocation', async () => {
        const body = { documents: [], forceUpload: true };
        await handler({ requestContext: { httpMethod: 'POST' }, body: JSON.stringify(body) }, mockContext);
        expect(processDirectInvocation).toHaveBeenCalledWith(expect.objectContaining({ forceUpload: true }));
    });

    it('routes forceRetry=true events to forceRetryAllItems', async () => {
        const res = await handler({ forceRetry: true }, mockContext);
        expect(res.statusCode).toBe(200);
        expect(forceRetryAllItems).toHaveBeenCalledOnce();
        expect(retryFailedItems).not.toHaveBeenCalled();
    });

    it('routes EventBridge (no special flags) to retryFailedItems', async () => {
        const res = await handler({}, mockContext);
        expect(res.statusCode).toBe(200);
        expect(retryFailedItems).toHaveBeenCalledOnce();
        expect(forceRetryAllItems).not.toHaveBeenCalled();
    });

    it('returns 200 body "done" on success', async () => {
        const res = await handler({}, mockContext);
        expect(res.body).toBe('done');
    });
});

describe('handler — error handling', () => {
    it('returns 500 when a sub-function throws', async () => {
        vi.mocked(retryFailedItems).mockRejectedValueOnce(new Error('DB down'));
        const res = await handler({}, mockContext);
        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.body).error).toContain('DB down');
    });
});
