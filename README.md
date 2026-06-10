# NYSCEF Uploader

This service automates the upload of stipulation, evidence, and misc letter documents to the New York State Courts Electronic Filing (NYSCEF) system. It supports three invocation modes: an SQS-triggered queue-based path (primary), a direct Lambda invocation path (legacy), and a scheduled EventBridge path for automatic retries.

---

## Features

- Uploads stipulation, evidence, and misc letter PDFs to NYSCEF via Playwright browser automation.
- **Queue-based processing** — reads from `Court.NyscefUploadQueue`, processes one document per SQS message.
- **Automatic retry** — failed items are retried up to 3 times via scheduled EventBridge trigger.
- **Stuck-item recovery** — items stuck in `PROCESSING` for 15+ minutes are automatically reset to `FAILED`.
- **Consolidated notifications** — waits for all items in an ingest to complete before sending a summary notification.
- **Browser stability** — browser initialization retries up to 3 times with a fresh Chromium instance on each attempt.
- Handles stipulations, evidence (Sales Comp Analysis / Equity Report), and misc letters (correspondence to judge).
- Emails SCAR clerks (with the negotiator CC'd) and handles withdrawal status updates after successful upload.
- Supports testing mode (no actual NYSCEF submission).
- Legacy direct-invocation path retained for backwards compatibility.

---

## Cloudflare & Login Infrastructure

### The problem

NYSCEF's login page is protected by Cloudflare. Cloudflare issues a cookie called `cf_clearance`
to browsers that pass its bot check — think of it as a wristband that lets you through the door
without being checked again. The catch: this wristband is cryptographically tied to your exact IP
address. Show up from a different IP and it's rejected.

AWS Lambda normally runs on a shared IP pool — each cold start (new container) gets a different
IP from a massive AWS-owned range. Any stored cookie is always wrong for the new IP. Cloudflare
also hard-blocks AWS datacenter IPs on NYSCEF with a 403 managed challenge that cannot be
auto-solved in a headless browser. Warm starts (reusing an already-running container) work fine
because the browser is already logged in and Cloudflare is never contacted again.

### The fix (implemented June 2026)

The Lambda was placed inside a dedicated VPC with a NAT Gateway backed by a fixed Elastic IP.
Every container — cold start or warm start — now egresses through that one address. Cloudflare
always sees the same IP.

After a successful first login from that IP, the `cf_clearance` cookie is stored in AWS Secrets
Manager (`nyscef/cf_clearance`). Every subsequent cold start injects the stored cookie before
navigating to NYSCEF. Cloudflare sees a valid cookie for a known IP and lets us through without
a challenge.

If the stored cookie ever becomes stale and triggers a 403, the code evicts it from Secrets
Manager automatically so the next attempt arrives clean and re-bootstraps.

### Current AWS network layout

```
Lambda (nyscef-uploader)
  └── VPC: nyscef-vpc
        ├── Private subnet: nyscef-private  ← Lambda lives here
        │     └── Route: 0.0.0.0/0 → NAT Gateway
        └── Public subnet: nyscef-public
              └── NAT Gateway: nyscef-nat
                    └── Elastic IP  ← fixed IP Cloudflare sees
                          └── Internet Gateway: nyscef-igw
```

| Resource | Name |
|----------|------|
| VPC | `nyscef-vpc` |
| Private subnet | `nyscef-private` (CIDR `10.0.1.0/24`) |
| Public subnet | `nyscef-public` (CIDR `10.0.0.0/24`) |
| Internet Gateway | `nyscef-igw` |
| NAT Gateway | `nyscef-nat` |
| Lambda security group | `nyscef-lambda-sg` |

> **Keep a note of the Elastic IP address.** If the cookie ever needs to be manually
> re-bootstrapped (see [EC2-COOKIE-BOOTSTRAP.md](EC2-COOKIE-BOOTSTRAP.md)), you need to know
> which IP the cookie was issued for.

### How the cookie flow works

**Cold start:**
1. `initBrowser.ts` reads `nyscef/cf_clearance` from Secrets Manager
2. If a value is present → injected into the browser context before any navigation
3. Navigates to NYSCEF — Cloudflare sees valid cookie for the known IP → no challenge
4. Logs in, processes queue items
5. Saves the latest `cf_clearance` back to Secrets Manager after successful login

**Warm start:** Browser and NYSCEF session are reused from the prior invocation. Login (and
Cloudflare) is bypassed entirely.

**Stale cookie detected (403 on an injected cookie):**
1. `login.ts` detects the 403 and calls `clearCfCookie()` — evicts the bad value from
   Secrets Manager immediately
2. Throws `CloudflareBlockError` (`noRetry=true`) to stop all retry loops
3. Next cold start arrives clean, gets a fresh cookie via the 503 interstitial path, saves it

### IAM permissions required

Beyond the standard Lambda execution policies:

| Permission | Resource | Why |
|------------|----------|-----|
| `AWSLambdaVPCAccessExecutionRole` (managed policy) | — | VPC network interface create/delete |
| `secretsmanager:GetSecretValue` | `nyscef/cf_clearance`, `db` | Read credentials and cookie |
| `secretsmanager:PutSecretValue` | `nyscef/cf_clearance` | Save or clear the cookie |

The `PutSecretValue` permission is an inline policy scoped to the specific secret ARN
(`arn:aws:secretsmanager:us-east-1:434028085475:secret:nyscef/cf_clearance*`).

### Related guides

| File | What it covers |
|------|---------------|
| [CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md) | Full step-by-step AWS Console instructions for VPC, NAT Gateway, EIP, Lambda VPC attachment, and the residential proxy fallback |
| [EC2-COOKIE-BOOTSTRAP.md](EC2-COOKIE-BOOTSTRAP.md) | How to spin up a temporary EC2 in the same VPC to earn the first `cf_clearance` cookie for the Elastic IP |

---

## Invocation Modes

The handler in `src/index.ts` routes to the appropriate path based on the event shape:

### 1. SQS Trigger (Primary)

**Triggered by**: SQS messages sent by `stipulation-ingest` or `evidence-ingest` when `NYSCEF_QUEUE_URL` is configured.

Each SQS message contains `{ id: <NyscefUploadQueue row ID> }`. The handler fetches the queue item from the database, downloads the PDF from S3, and uploads it to NYSCEF. One document is processed per message.

This is the preferred path — it processes documents immediately as they are queued, with built-in retry and status tracking.

### 2. Direct Lambda Invocation (Legacy)

**Triggered by**: Direct Lambda invocation with a `documents` array in the payload — used by `stipulation-ingest` and `evidence-ingest` when `NYSCEF_QUEUE_URL` is **not** configured.

**Payload format**:

```json
{
  "documents": [
    {
      "scarID": "string",            // Required: SCAR Index Number
      "parcelID": "string",          // Required: Parcel Identifier
      "year": 2025,                  // Required: Tax year (number)
      "countyCode": "string",        // Optional: auto-detected from parcelID if omitted
      "county": "string",            // Optional: auto-detected from county code map if omitted
      "negotiatorID": 123,           // Optional: auto-detected from database if omitted
      "isVillage": false,            // Optional: auto-detected from database if omitted
      "disposition": "W",            // Stipulations only: disposition code (e.g. "W" for withdrawal)
      "stipBufferKey": "string",     // Stipulations only: S3 key under stipulation-ingest-files/pdfs/
      "evidenceTypes": ["unequal"],  // Evidence only: list of evidence types ("unequal", "excessive")
      "unequalBufferKey": "string",  // Evidence only: S3 key for unequal evidence (auto-looked up if omitted)
      "excessiveBufferKey": "string",// Evidence only: S3 key for excessive evidence (auto-looked up if omitted)
      "miscBufferKey": "string"      // Misc only: S3 key under aventine-court-docs for the letter PDF
    }
  ],
  "testing": false,                  // Optional: if true, skips actual NYSCEF submission
  "ingestID": 456,                   // Optional: ingest tracking ID
  "realFrom": "user@email.com"       // Optional: sender email for clerk notifications
}
```

**Example — invoke from another Lambda in this repo**:

```js
import { invokeLambdaAsync } from '@shared/lambda.js';

await invokeLambdaAsync('nyscef-uploader', {
  documents: [
    {
      scarID: '12345/2025',
      parcelID: '103-1234567890',
      year: 2025,
      disposition: 'W',
      stipBufferKey: '103-1234567890_1234567890.pdf',
    },
  ],
  testing: true,
  realFrom: 'your@email.com',
});
```

**Example — invoke via AWS SDK**:

```js
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const client = new LambdaClient({ region: 'us-east-1' });
const command = new InvokeCommand({
  FunctionName: 'nyscef-uploader',
  Payload: Buffer.from(JSON.stringify({
    documents: [{ scarID: '12345/2025', parcelID: '103-1234567890', year: 2025, disposition: 'W', stipBufferKey: '103-1234567890_1234567890.pdf' }],
    testing: true,
  })),
});
const response = await client.send(command);
```

### 3. Login Test

**Triggered by**: Manual test invocation with `{ "_loginTest": true }`.

Launches a real browser, attempts the full NYSCEF login flow, and saves the resulting
`cf_clearance` cookie to Secrets Manager. Use this to verify the VPC + cookie injection setup
is working, or to bootstrap the cookie after resetting it. Does not process any queue items.

### 4. Self-Test Ping

**Triggered by**: Manual test invocation with `{ "_selfTest": true }`.

Just confirms the handler loaded and routed correctly. No browser, no network calls to NYSCEF.

### 5. Force Retry

**Triggered by**: Manual invocation with `{ "forceRetry": true }`.

Processes all items in `QUEUED` or `FAILED` status regardless of attempt count. Use when items
have exhausted their 3-attempt limit but you want to retry them anyway.

### 7. Scheduled EventBridge Trigger (Retry)

**Triggered by**: EventBridge scheduled rule (e.g. every 10 minutes).

Any event that is not an SQS event and does not contain a `documents` array is treated as a scheduled retry trigger. The handler:
1. Resets any items stuck in `PROCESSING` for 15+ minutes back to `FAILED`
2. Fetches all `FAILED` items with fewer than 3 attempts
3. Retries each eligible item

---

## Queue-Based Processing (`Court.NyscefUploadQueue`)

### Queue Item Lifecycle

```
QUEUED → PROCESSING → UPLOADED
                    → SKIPPED   (already uploaded to NYSCEF)
                    → FAILED    (error — eligible for retry if attempts < 3)
```

| Status | Description |
|---|---|
| `QUEUED` | Inserted by stipulation-ingest, evidence-ingest, or other callers, waiting to be processed |
| `PROCESSING` | Claimed by the uploader, upload in progress |
| `UPLOADED` | Successfully filed on NYSCEF |
| `SKIPPED` | Already uploaded in a previous run — no action taken |
| `FAILED` | Upload failed; `ErrorMessage` column holds the error; retried up to 3 times |

### Retry Logic

- Each item tracks an `Attempts` counter, incremented on each claim.
- Items with `Status = 'FAILED'` and `Attempts < 3` are eligible for retry.
- The scheduled EventBridge trigger runs the retry loop automatically.
- Items stuck in `PROCESSING` for more than 15 minutes are reset to `FAILED` with the message `"Timed out in PROCESSING state"`.

### Consolidated Notifications

In the SQS path, notifications are deferred until all items for a given `IngestID` are in a terminal state (`UPLOADED`, `SKIPPED`, or `FAILED`). This prevents a flood of individual notifications when a batch of stips arrives at once. Once the last item for an ingest completes, a single summary notification is sent.

---

## Response

- **200 OK**: `{ "statusCode": 200, "body": "done" }` on success.
- **500 Internal Server Error**: `{ "statusCode": 500, "body": "<error message>" }` on unhandled error.

---

## Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `NYSCEF_USERNAME` | Yes | NYSCEF portal login username |
| `NYSCEF_PASSWORD` | Yes | NYSCEF portal login password |
| `NYSCEF_QUEUE_URL` | Yes | SQS queue URL for upload jobs |
| `CF_INJECT_COOKIE` | Yes | Set to `true` in production — injects the stored `cf_clearance` cookie on cold starts. Only safe with a fixed egress IP (VPC + NAT Gateway). |
| `PROXY_URL` | No | `http://user:pass@host:port` — routes Playwright through a residential proxy. Only needed if the Elastic IP gets hard-blocked by Cloudflare. |
| `CF_COOKIE` | No | Legacy fallback cookie value. Ignored if Secrets Manager has a value. |
| `STIPULATIONS_EMAIL_CLIENT_ID` | Yes | OAuth2 credentials for clerk notification emails |
| `STIPULATIONS_EMAIL_CLIENT_SECRET` | Yes | OAuth2 credentials for clerk notification emails |
| `STIPULATIONS_EMAIL_REFRESH_TOKEN` | Yes | OAuth2 credentials for clerk notification emails |
| `STIPULATIONS_EMAIL_USER` | Yes | Sender address for clerk notification emails |
| `database`, `endpoint`, `user`, `password`, `port` | Yes | Database connection (overridden by `db` Secrets Manager secret in production) |

---

## Notes

- The SQS path processes one document per message. Evidence documents with multiple types (unequal + excessive) are inserted as separate queue items.
- The direct-invocation (legacy) path can handle multiple documents per call and sends notifications immediately after the full batch completes.
- If evidence S3 keys are not provided in the legacy path, they are auto-looked up from `aventine-court-docs/residential/evidence/{year}/{parcelID}/`.
- Only documents with `hasBeenUploaded: true` (and not `wasSkipped`) are processed for withdrawal status updates and clerk emails.
- Browser initialization retries up to 3 times with a fully fresh Chromium instance on each attempt — this handles Lambda shared memory (`/dev/shm`) exhaustion which can cause the browser process to crash on startup.
- **Document types**: Three types are supported — `STIPULATION` (filed as the appropriate stip variant based on disposition), `EVIDENCE` (filed as exhibit A/B), and `MISC` (filed as "LETTER / CORRESPONDENCE TO JUDGE"). Misc letter uploads are not deduplicated or DB-tracked; they can be re-uploaded freely.
- For type definitions, see [src/types.ts](src/types.ts).

---

## Troubleshooting

### Cloudflare / login issues

Use the `_loginTest` invocation to diagnose without touching real queue items:

```json
{ "_loginTest": true }
```

**Healthy cold start** (look for this in CloudWatch):
```
Injected cf_clearance cookie
Login page response: status=200...
Successfully logged into NYSCEF
```

**First run after cookie reset** (expected — bootstraps a new cookie):
```
cf_clearance is empty — arriving clean for this cold start
Cloudflare 503 interstitial — waiting for it to auto-solve...
Successfully logged into NYSCEF
Persisted fresh cf_clearance to Secrets Manager
```

**Stale cookie self-healing** (one-time, recovers automatically):
```
Injected cf_clearance cookie
Login page response: status=403...
Cleared stale cf_clearance from Secrets Manager
```
The next invocation will arrive clean and re-bootstrap. No action needed unless 403s persist.

**Hard 403 on a clean attempt** (IP is blocked — needs intervention):
```
cf_clearance is empty — arriving clean for this cold start
Login page response: status=403...
```
See [EC2-COOKIE-BOOTSTRAP.md](EC2-COOKIE-BOOTSTRAP.md) to try earning a cookie from a real
browser on the same IP. If that also fails, see the proxy fallback in
[CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md).

**Cookie expired** (~1 year lifespan):
Same as stale cookie — the self-healing code handles it automatically. If 403s persist through
multiple SQS retry cycles, manually reset:
- Secrets Manager → `nyscef/cf_clearance` → set to `{ "cf_clearance": "" }`
- Run `_loginTest` to force a clean bootstrap

**NYSCEF password needs reset** (login redirects to `/sspr/`):
Reset the password manually at the NYSCEF portal, then update `NYSCEF_PASSWORD` in Lambda
environment variables.

### Queue issues

- **Upload stuck in PROCESSING**: EventBridge retry automatically resets items stuck 15+ minutes.
  Check CloudWatch for the Lambda run that claimed the item.
- **All 3 attempts failed**: Check `ErrorMessage` in `Court.NyscefUploadQueue`. Common causes:
  Cloudflare block, case not found in NYSCEF, or NYSCEF session dropped mid-upload.
- **Browser crashes on startup**: Usually Lambda `/tmp` exhaustion. Increase ephemeral storage
  to 1024MB+ in Lambda configuration.
- **Legacy path — missing fields**: Each document needs `scarID`, `parcelID`, `year`, and one of
  `stipBufferKey`, `evidenceTypes`, or `miscBufferKey`.
- Use `testing: true` in the payload to run without actually submitting to NYSCEF.

---

## Maintainers

- Catherine Sangiovanni

For questions or support, contact: catherine@aventine.ai
