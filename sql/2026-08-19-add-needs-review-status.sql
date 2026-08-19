-- Adds NEEDS_REVIEW to Court.NyscefUploadQueue.Status, and a SubmittedAt marker.
--
-- Both changes are in ONE ALTER on purpose: each ALTER needs its own brief EXCLUSIVE metadata lock
-- to begin, and a pending exclusive request parks at the head of the MDL queue and blocks every
-- later request behind it. One statement means one lock acquisition instead of two.
--
-- WHY
-- Until now the uploader clicked #btnSubmit, slept 2s, and recorded UPLOADED unconditionally, so
-- the Status column could not distinguish "on the NYSCEF docket" from "we pressed a button".
-- Post-submit verification (src/uploader/verifySubmission.ts) now yields three outcomes, and the
-- third one has no safe home in the existing enum:
--
--   CONFIRMED -> UPLOADED
--   REJECTED  -> FAILED       (court refused it; nothing was filed; safe to retry)
--   UNKNOWN   -> NEEDS_REVIEW (submit was pressed, outcome unreadable; MAY be on the docket)
--
-- SubmittedAt closes the same hole for crashes rather than verdicts. It is stamped immediately
-- before #btnSubmit is clicked, so it answers the one question resetStuckProcessingItems could not:
-- a run that dies mid-filing leaves a row in PROCESSING, and whether that row is safe to retry
-- depends entirely on whether the submit had already gone out. NULL means it had not (clean
-- failure, retry it); non-NULL means it had (may be on the docket, needs a human).
--
-- UNKNOWN cannot be FAILED. claimQueueItem and getAllPendingItems both select
-- `Status IN ('QUEUED','FAILED')` with no attempt-count filter, and resetStuckProcessingItems
-- pushes PROCESSING -> FAILED after 15 minutes. Anything landing in FAILED is therefore re-filed
-- automatically — which, for a document the court may already hold, produces a duplicate court
-- filing. NEEDS_REVIEW is matched by none of those queries, so it is terminal for every automated
-- path and is cleared only by a human who has checked the docket.
--
-- BLAST RADIUS
-- Court.NyscefUploadQueue is small (~7.9k rows, 2.5 MB data + 1.5 MB index as of 2026-08-19).
-- This is an enum widening: additive, no existing row changes value, no reads break. It still
-- requires a brief EXCLUSIVE metadata lock to start, so run it when the queue is idle and confirm
-- nothing holds a long-lived MDL on the table first (see the pre-flight query below).
--
-- DEPLOY ORDER
-- Apply this migration BEFORE deploying the uploader. Writing an enum value the column does not
-- have fails with errno 1265 ("Data truncated"), which in this path would mean losing the record
-- of an ambiguous filing — the exact thing this change exists to prevent.
--
-- KEEP IN SYNC
-- Status is manually managed, like DocumentType. Consumers that enumerate it:
--   - nyscef-uploader   src/queue/queueClient.ts  (QueueItem.Status union)
--   - aventine-v2       ingest/queue status display
-- Add NEEDS_REVIEW anywhere statuses are rendered or filtered, or it will show as unknown.

-- Pre-flight: confirm nothing holds a long-lived metadata lock on the table.
-- Expect an empty result, or only short-lived (low PROCESSLIST_TIME) entries.
SELECT t.PROCESSLIST_ID, t.PROCESSLIST_USER, t.PROCESSLIST_TIME, ml.LOCK_TYPE, ml.LOCK_STATUS
FROM performance_schema.metadata_locks ml
JOIN performance_schema.threads t ON t.THREAD_ID = ml.OWNER_THREAD_ID
WHERE ml.OBJECT_NAME = 'NyscefUploadQueue' AND ml.LOCK_STATUS = 'GRANTED'
ORDER BY t.PROCESSLIST_TIME DESC;

-- Fail fast rather than parking an exclusive request at the head of the MDL queue, where it would
-- block every later SELECT on the table behind it.
SET SESSION lock_wait_timeout = 10;

ALTER TABLE Court.NyscefUploadQueue
    MODIFY COLUMN Status ENUM('QUEUED','PROCESSING','UPLOADED','FAILED','SKIPPED','NEEDS_REVIEW')
    NOT NULL DEFAULT 'QUEUED',
    ADD COLUMN SubmittedAt DATETIME NULL DEFAULT NULL AFTER Attempts;

-- Verify.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'Court' AND TABLE_NAME = 'NyscefUploadQueue'
  AND COLUMN_NAME IN ('Status', 'SubmittedAt');

-- Backfill note: every existing row keeps SubmittedAt = NULL. That is correct — those rows are all
-- in terminal states already, and the column is only ever read for rows sitting in PROCESSING.
