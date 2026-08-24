import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/shared_helpers/sql.js', () => ({
    executeSQLQuery: vi.fn(),
    getUserDetails: vi.fn().mockResolvedValue(null),
}));

import { executeSQLQuery } from '../../src/shared_helpers/sql.js';
import { isIngestHandedOff } from '../../src/queue/queueClient.ts';
import { resolveIngestOutcome } from '../../src/queue/queueProcessor.ts';
import { IngestStatus } from '../../src/shared_helpers/types.ts';

const mockSQL = vi.mocked(executeSQLQuery);

beforeEach(() => {
    vi.clearAllMocks();
    mockSQL.mockReset();
});

/**
 * The handoff gate exists because "no pending queue rows" is not the same as "the run is over".
 * stipulation-ingest inserts one row at a time inside its page loop, so an ingest can be entirely
 * un-pending while most of it has not been written yet. Ingest 1506 finished its first upload seven
 * seconds before its last row was inserted, and ingest 1445 gained a row 2h19m after its previous
 * thirty had all completed. Acting on that closes and notifies a 55-page run on the strength of one
 * page.
 */
describe('isIngestHandedOff', () => {
    it('defers while the producer is still queueing', async () => {
        mockSQL.mockResolvedValue([{ Status: 'Processing', IsStale: 0 }]);
        expect(await isIngestHandedOff(1506, 15)).toBe(false);
    });

    it('proceeds once the producer has written Uploading', async () => {
        mockSQL.mockResolvedValue([{ Status: 'Uploading', IsStale: 0 }]);
        expect(await isIngestHandedOff(1506, 15)).toBe(true);
    });

    // Without this a producer that dies mid-loop pins its ingest at Processing forever, and the gate
    // then suppresses the notification permanently — strictly worse than the premature one it exists
    // to prevent. LastAccessTimestamp is bumped per item, so staleness really does mean "stopped".
    it('stops waiting on a producer that has gone quiet', async () => {
        mockSQL.mockResolvedValue([{ Status: 'Processing', IsStale: 1 }]);
        expect(await isIngestHandedOff(1506, 15)).toBe(true);
    });

    // A queue row pointing at an ingest that no longer exists can never be un-stuck by waiting.
    it('does not wait forever on an ingest row that is missing', async () => {
        mockSQL.mockResolvedValue([]);
        expect(await isIngestHandedOff(999999, 15)).toBe(true);
    });
});

/**
 * These pin one property: 'Failed' means nothing in the run got anywhere — not that the queued part
 * didn't. Each case is a different way the queue-only view of a run gets that wrong.
 */
describe('resolveIngestOutcome', () => {
    /**
     * Ingest 1354's shape: 4 BAR pages filed to the portal by the producer, 21 SCAR pages queued for
     * NYSCEF. BAR and Westchester pages never enter the queue, so a wholly-failed queue says nothing
     * about them — reading the queue alone would report four successful filings as a total loss.
     */
    it('does not call a mixed run Failed when only its queued half failed', () => {
        const ledger = new Map([
            ['Uploaded', 4], // the BAR pages, filed before anything was queued
            ['Failed', 21],
        ]);
        const { status } = resolveIngestOutcome(ledger, { uploadedCount: 0, skippedCount: 0, resultStr: '21 Failed' });
        expect(status).toBe(IngestStatus.Done);
    });

    it('calls a run Failed only when nothing in it got anywhere', () => {
        const { status } = resolveIngestOutcome(new Map([['Failed', 3]]), { uploadedCount: 0, skippedCount: 0, resultStr: '3 Failed' });
        expect(status).toBe(IngestStatus.FAILED);
    });

    // SKIPPED means the document was already on the docket. Treating it as failure would turn every
    // duplicate re-send into a red run.
    it('treats already-filed documents as an outcome, not a failure', () => {
        const { status } = resolveIngestOutcome(new Map([['Skipped', 2]]), { uploadedCount: 0, skippedCount: 2, resultStr: '2 Skipped' });
        expect(status).toBe(IngestStatus.Done);
    });

    // Evidence and misc ingests create no IngestItem rows at all, so an empty ledger has to mean
    // "ask the queue" rather than "nothing succeeded" — otherwise every evidence run ends Failed.
    it('falls back to queue counts for ingests that keep no item ledger', () => {
        const { status, summary } = resolveIngestOutcome(new Map(), { uploadedCount: 3, skippedCount: 0, resultStr: '3 Uploaded' });
        expect(status).toBe(IngestStatus.Done);
        expect(summary).toBe('3 Uploaded');
    });
});
