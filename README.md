# NYSCEF Uploader

Automates the upload of stipulation, evidence, and misc letter documents to the New York State Courts Electronic Filing (NYSCEF) system via Playwright browser automation. Runs as a long-lived Docker container that polls SQS for jobs.

---

## How it works

A long-running Node.js worker (`src/worker.ts`) does two things:

- **Polls SQS** every 20 seconds for new upload jobs (each message is `{ id: <NyscefUploadQueue row ID> }`)
- **Retries failed items** every 15 minutes (items stuck in `PROCESSING` > 15 min are reset to `FAILED` first)

Each job fetches the queue item from `Court.NyscefUploadQueue`, downloads the PDF from S3, launches a Chromium browser, logs into NYSCEF, and files the document. One document per SQS message.

Everything else — database, S3, Secrets Manager, invoking other Lambdas — is unchanged from the Lambda version.

For full deployment instructions, see [SERVER-DEPLOY.md](SERVER-DEPLOY.md).

---

## Features

- Uploads stipulation, evidence, and misc letter PDFs to NYSCEF via Playwright + Chromium
- **Queue-based processing** — reads from `Court.NyscefUploadQueue`, processes one document per SQS message
- **Automatic retry** — failed items are retried up to 3 times; scheduler runs every 15 minutes
- **Stuck-item recovery** — items stuck in `PROCESSING` for 15+ minutes are automatically reset to `FAILED`
- **Consolidated notifications** — waits for all items in an ingest to complete before sending a summary notification
- **Browser stability** — browser initialization retries up to 3 times with a fresh Chromium instance on each attempt
- Handles stipulations, evidence (Sales Comp Analysis / Equity Report), and misc letters (correspondence to judge)
- Emails SCAR clerks (with the negotiator CC'd) and handles withdrawal status updates after successful upload
- Supports testing mode (no actual NYSCEF submission)

---

## Cloudflare & Login

NYSCEF's login page is protected by Cloudflare, which issues a `cf_clearance` cookie that is cryptographically tied to your IP address. Because this container runs on a server with a fixed IP, the same cookie is valid for every login attempt.

### Cookie flow

**First run (no existing cookie):**
1. `initBrowser.ts` reads `nyscef/cf_clearance` from Secrets Manager — empty
2. Browser navigates to NYSCEF without injecting a cookie
3. Cloudflare shows a 503 interstitial ("Checking your browser...") — the browser auto-solves it
4. Login succeeds; the resulting `cf_clearance` is saved back to Secrets Manager

**Subsequent runs:**
1. `initBrowser.ts` reads `nyscef/cf_clearance` from Secrets Manager — has a value
2. Cookie is injected into the browser context before any navigation
3. Cloudflare sees a valid cookie for the known server IP → no challenge
4. Login succeeds; saves the latest cookie back to Secrets Manager

**Stale cookie (403 on an injected cookie):**
1. `login.ts` detects the 403 and calls `clearCfCookie()` — evicts the bad value from Secrets Manager
2. Throws `CloudflareBlockError` to stop retry loops immediately
3. Next attempt arrives clean and re-bootstraps via the 503 interstitial path

### NYSCEF credentials

Username and password are stored in the `nyscef/credentials` Secrets Manager secret
(`{ "username": "...", "password": "..." }`). They are fetched on the first login attempt and
cached in-process for the lifetime of the container.

---

## Queue Item Lifecycle

```
QUEUED → PROCESSING → UPLOADED
                    → SKIPPED   (already uploaded to NYSCEF)
                    → FAILED    (error — eligible for retry if Attempts < 3)
```

| Status | Description |
|--------|-------------|
| `QUEUED` | Waiting to be processed |
| `PROCESSING` | Claimed, upload in progress |
| `UPLOADED` | Successfully filed on NYSCEF |
| `SKIPPED` | Already uploaded in a previous run — no action taken |
| `FAILED` | Upload failed; `ErrorMessage` has the reason; retried up to 3 times |

### Retry logic

- `Attempts` counter is incremented each time an item is claimed
- Items with `Status = 'FAILED'` and `Attempts < 3` are retried by the scheduler
- Items stuck in `PROCESSING` for more than 15 minutes are reset to `FAILED` with the message `"Timed out in PROCESSING state"` — this handles crashes or container restarts mid-upload

### Consolidated notifications

Notifications are deferred until all items for a given `IngestID` reach a terminal state (`UPLOADED`, `SKIPPED`, or `FAILED`). This sends one summary notification per ingest instead of one per document.

---

## Document Types

Three types are supported — all handled by `DocumentType` in `src/types.ts`:

| Type | NYSCEF filing type | Notes |
|------|--------------------|-------|
| `STIPULATION` | Appropriate stip variant based on `disposition` code | DB: `StipTracking.Status = 'NyscefUploaded'` |
| `EVIDENCE` | `EXHIBIT(S)`, auto-lettered A→Z | DB: `Court.UploadedEvidence`; deduped per `(ParcelID, Year, identifier)` |
| `MISC` | Depends on the identifier code — see below | DB: `Court.UploadedLetters` or `Court.UploadedMiscDocs` |

The doc-type branch lives in [`src/uploader/upload.ts`](src/uploader/upload.ts) (NYSCEF dropdown selection),
[`src/uploader/checkAlreadyUploaded.ts`](src/uploader/checkAlreadyUploaded.ts) (dedup), and
[`src/uploader.ts`](src/uploader.ts) (post-upload DB write). The queue processor itself does **not** branch on
`DocumentType` — it prepares and uploads every item uniformly.

### MISC documents

`MISC` covers two distinct flows, distinguished by `isArbitraryMiscDoc()` in [`src/types.ts`](src/types.ts):

| Flow | Condition | NYSCEF type | Dedup |
|------|-----------|-------------|-------|
| **Legacy motion letter** | `Identifier = 'letter'`, or no `S3Key` (direct-invoke) | `LETTER / CORRESPONDENCE TO JUDGE` | `Court.UploadedLetters` on `(ParcelID, Year)` |
| **Arbitrary misc document** | any other `Identifier` **and** a non-empty `S3Key` | resolved from `Identifier` via `MISC_CODE_TO_LABEL` | `Court.UploadedMiscDocs` on `(ParcelID, Year, S3Key, DocType)` |

The `S3Key` requirement is deliberate: the legacy direct-invocation path (`direct.ts`) builds `Document`s with
no queue row and therefore no `S3Key`, and may set `identifier` to a disposition code. It must stay on the
`UploadedLetters` path — otherwise it would write dedup rows keyed on an empty `S3Key` and silently skip every
later misc doc for that parcel.

**Identifier code → NYSCEF label** (`MISC_CODE_TO_LABEL` in `upload.ts` — keep in sync with `MISC_DOC_TYPES`
in `evidence-ingest/src/types.ts`):

| Code | NYSCEF label | Behavior |
|------|--------------|----------|
| `EXHIBIT` (default) | `EXHIBIT(S)` | Reuses the evidence exhibit-labeling path (numbered by default — see below); fills the exhibit description field (`#txtDocDes_1`) with the queue row's `Description`, falling back to `"Exhibit"` |
| `LETTER` | `LETTER / CORRESPONDENCE TO JUDGE` | Selects the dropdown, then best-effort fills the "Additional Document Information" box (`#txtDocDes_1`, the same element the exhibit form uses) with `Description` if one was supplied |

Unrecognized codes default to `EXHIBIT(S)`.

The description fill on the non-exhibit path (`fillOptionalDescription` in `upload.ts`) is best-effort:
NYSCEF renders one filing form and relabels its fields per doc type, so `#txtDocDes_1` is present for
both `EXHIBIT(S)` and `LETTER`. If a future doc type does not render it, the fill is skipped with a
warning rather than failing the filing — a description is optional metadata, not worth aborting a
valid court filing over.

### Exhibit labeling

`computeNextExhibitLabel` (`upload.ts`) picks the label for anything filed as `EXHIBIT(S)`. Exhibits are
**numbered** (1, 2, 3…) by default — we file as the petitioner, and NY convention numbers petitioner exhibits
while lettering respondent exhibits. `LETTER` is available per-filing for judges who ask for it. Resolution
order:

1. The queue row's `ExhibitLabelMode` (`NUMBER` | `LETTER`), set from the `exhibitLabelMode` request param.
2. Continuity: if **we** already filed exhibits in one style on this case, keep that style.
3. `NUMBER` (the default).

Only our own exhibits feed steps 2 and 3 — the opposing party's neither set the style nor advance the counter,
so our "Exhibit 1" can coexist with theirs. Both use max+1, so gaps are left alone. Lettering throws once
`Z` is reached; numbering has no ceiling.

> **Ordering constraint:** `scrapeExistingExhibits` must run while the browser is still on the
> **Document List** page, before clicking "File to this Case". The filing form ("Add Documents")
> lists `EXHIBIT(S)` only as `<option>` text in the doc-type dropdown — it has no filed-document rows
> and no "Filed By" cells. Scraping there returns an empty list silently, which is exactly the bug
> that caused every exhibit to be filed as "A" before this was fixed.

Attribution reads the document table's "Filed By" cell and compares it to `filerName` in the
`nyscef/credentials` secret. (The row's `filerId` is re-encrypted per docket and is useless as an identity.) If
`filerName` is unset or matches nothing, the uploader warns and treats no rows as ours — falling back to the
default (numbering).

Because `evidence-ingest` derives `S3Key` from a SHA-256 of the file's bytes, re-sending an **identical** file
is idempotent (deduped), while re-sending a **corrected** file produces a new key and re-uploads. Filing the
same file under two different doc types counts as two distinct filings.

Dedup bypasses: `ForceUpload = true` on the queue row, or a `RealFrom` containing `propriety`. Testing mode
skips all DB writes.

---

## Environment Variables

All credentials are in Secrets Manager — only infrastructure config goes in `.env`.

| Variable | Required | Description |
|----------|----------|-------------|
| `AWS_ACCESS_KEY_ID` | Yes | IAM user credentials |
| `AWS_SECRET_ACCESS_KEY` | Yes | IAM user credentials |
| `AWS_REGION` | Yes | e.g. `us-east-1` |
| `NYSCEF_QUEUE_URL` | Yes | SQS queue URL — AWS Console → SQS → your queue → copy URL |
| `CF_INJECT_COOKIE` | Yes | Set to `true` — server has a fixed IP, so cookie injection is safe and prevents Cloudflare challenges |
| `WARM_START_LOGIN` | No | `true` = browser launches at container startup so the first upload has no cold-start delay. Default: `false` |
| `NOTIFY_RECIPIENTS` | No | Comma-separated email addresses to notify on upload results |
| `NOTIFY_SLACK_RECIPIENTS` | No | Comma-separated Slack user IDs for error notifications |

Secrets Manager secrets (not env vars):

| Secret ID | Shape | Purpose |
|-----------|-------|---------|
| `db` | `{ host, port, username, password, dbname }` | MySQL connection |
| `nyscef/credentials` | `{ username, password }` | NYSCEF portal login |
| `nyscef/cf_clearance` | `{ cf_clearance }` | Cloudflare cookie — read/write by the uploader |

---

## Deployment

Merging a PR to `main` runs unit tests and auto-deploys to the server via Docker context over SSH.
The container is built on the server — no source files are stored there.

See [SERVER-DEPLOY.md](SERVER-DEPLOY.md) for initial server setup, docker context configuration,
and GitHub Actions secrets setup (including Tailscale for private network access).

---

## Running locally / diagnostics

```bash
# Build and start
docker compose build
docker compose up -d

# Watch logs
docker compose logs -f

# Trigger a login test (verifies browser + Cloudflare + Secrets Manager)
docker compose exec nyscef-uploader node -e "
import('./dist/uploader.js').then(m => m.testLogin()).then(() => {
  console.log('Login test complete.');
  process.exit(0);
}).catch(err => {
  console.error('Login test failed:', err.message);
  process.exit(1);
});
"

# Force-retry all exhausted items
docker compose exec nyscef-uploader node -e "
import('./dist/queue/queueProcessor.js').then(m => m.forceRetryAllItems()).then(() => {
  console.log('Done.'); process.exit(0);
}).catch(err => { console.error(err.message); process.exit(1); });
"
```

---

## Troubleshooting

### Cloudflare / login issues

**Healthy cold start:**
```
Injected cf_clearance cookie
Login page response: status=200...
Successfully logged into NYSCEF
```

**First run after cookie reset (expected — bootstraps a new cookie):**
```
cf_clearance is empty — arriving clean for this cold start
Cloudflare 503 interstitial — waiting for it to auto-solve...
Successfully logged into NYSCEF
Persisted fresh cf_clearance to Secrets Manager
```

**Stale cookie self-healing (one-time, recovers automatically):**
```
Injected cf_clearance cookie
Login page response: status=403...
Cleared stale cf_clearance from Secrets Manager
```
Next attempt arrives clean and re-bootstraps. No action needed unless 403s persist.

**403 persists after multiple attempts:**
The server's IP may be temporarily blocked. Wait 10–15 minutes and run the login test again.
If it keeps failing, check whether the IP changed (ISP reassignment) or contact Cloudflare support.

**NYSCEF password needs reset:**
Reset at the NYSCEF portal, then update `nyscef/credentials` in Secrets Manager.
No container restart needed — credentials are fetched on each login attempt.

### Queue issues

- **Item stuck in PROCESSING**: Retry scheduler resets these automatically every 15 minutes. Restart the container to trigger an immediate reset: `docker compose restart`
- **All 3 attempts failed**: Check `ErrorMessage` in `Court.NyscefUploadQueue`. Common causes: Cloudflare block, case not found in NYSCEF, NYSCEF session dropped mid-upload
- **Container won't start**: Check `docker compose logs` — usually a missing or malformed `.env`, or `NYSCEF_QUEUE_URL` not set

---

## Source layout

```
src/
  worker.ts                 — entry point: SQS poll loop + retry scheduler
  index.ts                  — original Lambda handler (kept, not used by the worker)
  uploader.ts               — browser session management + upload orchestration
  types.ts                  — Document, DocumentType, EventInput
  errors.ts                 — CloudflareBlockError
  direct.ts                 — legacy direct-invocation path
  uploader/
    addBrowser.ts           — browser launch + login with retries
    login.ts                — NYSCEF login flow + Cloudflare detection
    initBrowser.ts          — cf_clearance cookie inject/save/clear
    upload.ts               — actual NYSCEF form navigation and filing
    checkAlreadyUploaded.ts — deduplication check
    cleanupStaleBrowsers.ts — browser cleanup
  queue/
    queueClient.ts          — NyscefUploadQueue DB operations
    queueProcessor.ts       — SQS record handler + retry runner
  preparer/
    prepareFromQueueItem.ts — DB row → Document shape
  emailer/
    emailSCARClerk.ts       — clerk notification email via gmail-sender
    notifyResults.ts        — success/failure notification via notifier
    getClerkEmail.ts        — look up clerk email for a county
    getCourtDate.ts         — look up next court date for a case
  helpers/
    retry.ts                — generic async retry wrapper
    screenshot.ts           — error screenshot capture → S3
    withdrawals.ts          — withdrawal status update after upload
    negotiator.ts           — look up negotiator for a parcel
    determineIsVillage.ts   — village detection
  shared_helpers/           — copies of _SHARED library modules (sql, s3, secrets, etc.)
```

---

## Maintainers

Catherine Sangiovanni — catherine@aventine.ai
