# Runbook — Cloudflare 403 / "uploads systemically broken"

On-call guide for the NYSCEF uploader when you get a page like:

> **3 consecutive NYSCEF upload failures — uploads appear systemically broken.**
> Latest: ParcelID … Cloudflare challenge (status=403, url=…`__cf_chl_rt_tk`…) — cf_clearance
> cookie missing or IP-mismatched for this Lambda container

## TL;DR

This alert is almost always a **transient Cloudflare rate-limit blip that self-heals**. Before
touching anything, run the [triage query](#step-1-did-it-already-self-heal-run-this-first) — most
of the time the items already re-uploaded on a later attempt and there is nothing to fix. Only if
you see items **stuck** (`FAILED` / `PROCESSING`, or `Attempts` climbing toward exhaustion) do you
have a live outage; go to [Live outage](#live-outage-403-persists).

## What is actually happening

NYSCEF's login page sits behind Cloudflare. The uploader logs in with a stealth headless browser
([src/uploader/login.ts](src/uploader/login.ts)). Cloudflare has two block shapes:

| Shape | HTTP | Solvable by our browser? | Notes |
|-------|------|--------------------------|-------|
| Legacy "checking your browser" interstitial | `503` | **Yes** — JS auto-solves | The happy path when arriving clean |
| Managed challenge (`__cf_chl_rt_tk` in URL) | `403` | **No** — server-side, TLS/fingerprint-gated | What you see in the page text |

The `cf_clearance` cookie that lets us skip challenges is **cryptographically bound to our
outbound IP** ([README.md](README.md#L38)). It's earned on a successful 503 solve and reused. When
the IP's reputation dips (too many rapid sessions) or the IP changes, Cloudflare escalates to the
`403` managed challenge, which the stealth browser cannot solve.

**Why it pages at "3":** the SQS poll loop and the 15-min retry scheduler share one browser
session ([src/uploader.ts](src/uploader.ts)). A brief block makes several queued items fail their
first attempt back-to-back; three in a row is the [`uploadHealth`](src/helpers/uploadHealth.ts)
circuit-breaker threshold, so it pages — even though the retry a few minutes later usually
succeeds.

## Step 1 — Did it already self-heal? (run this first)

Read-only, safe. Table is `Court.NyscefUploadQueue`.

```sql
-- The parcel(s) named in the alert — did they end up UPLOADED?
SELECT ID, ParcelID, Status, Attempts, LEFT(ErrorMessage, 90) AS Err, UpdatedAt
FROM Court.NyscefUploadQueue
WHERE ParcelID = 'PASTE_PARCELID_FROM_ALERT'
ORDER BY UpdatedAt DESC;

-- Anything actually stuck right now?
SELECT Status, COUNT(*) AS cnt
FROM Court.NyscefUploadQueue
WHERE UpdatedAt > NOW() - INTERVAL 1 DAY
GROUP BY Status;
```

Interpreting the result:

- **`Status = UPLOADED` (even with `Attempts = 2` and a Cloudflare error string):** it self-healed.
  No action needed. ✅
  > ⚠️ **Gotcha:** `markUploaded()` never clears `ErrorMessage`
  > ([src/queue/queueClient.ts](src/queue/queueClient.ts#L45)). An `UPLOADED` row can still carry
  > the 403 string from its failed first attempt. **Trust `Status`, not `ErrorMessage`.**
- **No `FAILED` / `PROCESSING` rows, everything `UPLOADED`/`SKIPPED`:** queue is clean, outage is
  over. Close the page. ✅
- **`FAILED` rows with `Attempts >= 3`, or `Attempts` still climbing:** live outage → next section.

## Live outage (403 persists)

Run these **on the server the worker runs on** (the outbound IP is the whole ballgame; it can't be
checked from anywhere else).

```bash
# 1. What IP does Cloudflare see for us right now?
curl -s https://ifconfig.me ; echo

# 2. What cf_clearance is stored? (the first 403 wipes it to "" via clearCfCookie)
aws secretsmanager get-secret-value --secret-id nyscef/cf_clearance \
  --query SecretString --output text
```

Then re-bootstrap the cookie for the **current** IP by following
[SERVER-DEPLOY.md → Part 5 "Bootstrap the Cloudflare Cookie"](SERVER-DEPLOY.md#part-5--bootstrap-the-cloudflare-cookie)
(restart with `WARM_START_LOGIN=true`, or run the login test). Watch the logs:

- `Cloudflare 503 interstitial — waiting for it to auto-solve...` → `Persisted fresh cf_clearance`
  = **success.** The IP was fine, the cookie was just stale. Uploads resume; recover any burned
  items with `forceRetryExhaustedItems` (see below).
- Still `status=403` on a **clean** arrival → the **IP itself** is the problem. You cannot mint a
  cookie you can't earn. Options, in order:
  1. **Wait it out.** Rate-limit reputation often recovers on its own in tens of minutes — the
     [cooldown circuit](#the-cooldown-circuit) is already doing this for you.
  2. **Rotate the outbound IP** (new EIP / restart the NAT / ISP re-lease). Confirm it changed with
     `curl ifconfig.me`, then re-bootstrap.
  3. **Route through a residential/mobile proxy.** The browser already honors `PROXY_URL`
     ([src/uploader/initBrowser.ts](src/uploader/initBrowser.ts#L102)); set it in the env and
     restart. This gives a fresh, residential-reputation egress.

### Recovering items that burned their attempts

During a longer outage, items exhaust `MAX_ATTEMPTS` (3) and stop being retried automatically.
Once uploads work again, re-run them (ignores the attempt cap):

- `forceRetryExhaustedItems()` — re-runs only `FAILED` items with `Attempts >= 3`.
- `forceRetryAllItems()` — re-runs every non-terminal item.

Both live in [src/queue/queueProcessor.ts](src/queue/queueProcessor.ts). Historical note: the June
incidents show items reaching `Attempts = 4`/`5`, i.e. they required exactly this manual force-retry.

## The cooldown circuit

To stop a blip from stampeding the queue, the worker **pauses all consumption** as soon as a
Cloudflare block is seen ([src/helpers/cfCooldown.ts](src/helpers/cfCooldown.ts)):

- On a `CloudflareBlockError`, `enterCooldown()` pauses the SQS poll loop **and** the retry
  scheduler for `CF_COOLDOWN_MS` (default **10 min**). Paused items stay in the queue undelivered,
  so they **keep their full retry budget** instead of burning attempts against the wall.
- When the window expires the worker probes with a single item. Success → `clearCooldown()`,
  everything resumes. Another block → re-arm.
- **Paging policy:** the first pause is **silent** (it's usually a self-healing blip). It pages
  (`major`, component `cloudflare-cooldown`) only if the block **outlives one full window** — i.e.
  a genuinely sustained outage — and reports healthy on recovery.

What you'll see in the worker logs during a pause:

```
[cf-cooldown] Cloudflare block (arm #1) — pausing NYSCEF uploads for 600s. ParcelID …
[worker] Cloudflare cooldown active — pausing SQS consumption (583s remaining).
[worker] Cloudflare cooldown active — skipping scheduled retry (571s remaining).
```

Tuning: set `CF_COOLDOWN_MS` in `.env` (e.g. `300000` for 5 min). Lower = probes sooner but risks
re-triggering the rate limit; higher = gentler on the IP but slower recovery.

## Escalation

If a **clean** arrival keeps returning `403` after an IP rotation / proxy and a re-bootstrap, this
is no longer a transient blip — Cloudflare has flagged the egress or tightened policy on the login
endpoint. Escalate: confirm the IP with the ISP, consider a dedicated proxy, or contact Cloudflare
via the court system's channel. See [README.md → Cloudflare / login issues](README.md#cloudflare--login-issues).

## Quick reference

| Thing | Where |
|-------|-------|
| Block detection + error message | [src/uploader/login.ts](src/uploader/login.ts) |
| Cookie load / inject / evict | [src/uploader/initBrowser.ts](src/uploader/initBrowser.ts) |
| Consecutive-failure pager (threshold 3) | [src/helpers/uploadHealth.ts](src/helpers/uploadHealth.ts) |
| Cooldown pause + sustained-outage pager | [src/helpers/cfCooldown.ts](src/helpers/cfCooldown.ts) |
| Force-retry helpers | [src/queue/queueProcessor.ts](src/queue/queueProcessor.ts) |
| Cookie bootstrap procedure | [SERVER-DEPLOY.md Part 5](SERVER-DEPLOY.md) |
| Queue table | `Court.NyscefUploadQueue` |
| Stored cookie | Secrets Manager `nyscef/cf_clearance` |
| Proxy override | env `PROXY_URL` |
| Cooldown window | env `CF_COOLDOWN_MS` (default 600000) |
