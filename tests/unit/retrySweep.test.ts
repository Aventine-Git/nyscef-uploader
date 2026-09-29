import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/queue/queueClient.js');
vi.mock('../../src/uploader.js', () => ({ uploadToNyscef: vi.fn() }));
vi.mock('../../src/preparer/prepareFromQueueItem.js', () => ({ prepareFromQueueItem: vi.fn().mockResolvedValue({}) }));
vi.mock('../../src/emailer/emailSCARClerk.js', () => ({ emailSCARClerk: vi.fn() }));
vi.mock('../../src/emailer/notifyResults.js', () => ({ notifyResults: vi.fn() }));
vi.mock('../../src/helpers/withdrawals.js', () => ({ handleWithdrawals: vi.fn() }));
vi.mock('../../src/shared_helpers/reporter.js', () => ({ reportIncident: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/shared_helpers/ingestTracking.js', () => ({ updateIngestTrackingStatus: vi.fn() }));

import { claimQueueItem, getRetryItems, markSkipped, markUploaded, resetStuckProcessingItems, type QueueItem } from '../../src/queue/queueClient.js';
import { uploadToNyscef } from '../../src/uploader.js';
import { retryFailedItems } from '../../src/queue/queueProcessor.ts';

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resetStuckProcessingItems).mockResolvedValue({ needsReviewIDs: [] });
});

// The sweep works from a snapshot, so SQS can file a row before the sweep reaches it; re-running that
// row relabelled 67 filed rows SKIPPED on 2026-09-29, which drops a stipulation from the clerk email.
describe('retryFailedItems', () => {
    it('leaves a row alone once another pass has claimed it', async () => {
        const snapshot = { ID: 11192, ParcelID: 'D2800-6358-03-496133-0000', Status: 'QUEUED', IngestID: null } as unknown as QueueItem;
        vi.mocked(getRetryItems).mockResolvedValue([snapshot]);
        vi.mocked(claimQueueItem).mockResolvedValue(false);

        await retryFailedItems();

        expect(uploadToNyscef).not.toHaveBeenCalled();
        expect(markSkipped).not.toHaveBeenCalled();
        expect(markUploaded).not.toHaveBeenCalled();
    });
});
