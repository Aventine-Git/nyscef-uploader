# Runbook — Cloudflare 403 / "uploads systemically broken"

On-call guide for the NYSCEF uploader when you get a page like:

> **3 consecutive NYSCEF upload failures — uploads appear systemically broken.**
> Latest: ParcelID … Cloudflare challenge (status=403, url=…`__cf_chl_rt_tk`…) — cf_clearance
> cookie missing or IP-mismatched for this Lambda container

## TL;DR

**First, find out which of two very different things this is — they both arrive as HTTP 403 and the
status code cannot tell them apart.** Run this from the server:

```bash
curl -s https://iapps.courts.state.ny.us/nyscef/Login | grep -oE "Request Could Not Be Processed|Just a moment"
```

- **`Just a moment`** (or no match) → an ordinary **challenge**. Usually a transient rate-limit blip
  that self-heals. Go to [Step 1](#step-1-did-it-already-self-heal-run-this-first) — most of the time
  the items already re-uploaded on a later attempt and there is nothing to fix.
- **`Request Could Not Be Processed`** → our **egress IP is denied**. No cookie, retry or cooldown
  will fix this; it does not self-heal. Skip to [Egress denied](#egress-denied-the-ip-is-blocked).

Confirm which by comparing against an unrelated IP — and note the dev workstation shares the office
egress, so it is *not* a second vantage point:

```bash
curl -s https://r.jina.ai/https://iapps.courts.state.ny.us/nyscef/Login | head -5
```

Deny here + challenge there = the IP is blocked. Same page both places = something broader.

> The uploader used to report *every* 403 as "cf_clearance cookie missing or IP-mismatched". On
> 2026-09-10 that sent the response chasing cookies for hours against a deny-listed IP, and on
> 2026-09-29 against a browser Cloudflare had started flagging. `login.ts` now says which: a deny
> names itself and carries the `cf-ray` you need to open a ticket with OCA; a challenge says it is
> a stale cookie *or* a flagged browser, and [Browser flagged](#browser-flagged-challenged-even-arriving-clean)
> tells those two apart.

## What is actually happening

NYSCEF's login page sits behind Cloudflare. The uploader logs in with a stealth headless browser
([src/uploader/login.ts](src/uploader/login.ts)). Cloudflare has three block shapes:

| Shape | HTTP | Solvable by our browser? | Notes |
|-------|------|--------------------------|-------|
| Legacy "checking your browser" interstitial | `503` | **Yes** — JS auto-solves | The happy path when arriving clean |
| Managed challenge (`__cf_chl_rt_tk` in URL, or `Just a moment`) | `403` | **No** — server-side, TLS/fingerprint-gated | What a stale cookie *or* a flagged browser build draws. Clears when its cause does |
| **Egress deny** — `Request Could Not Be Processed` | `403` | **Never** | Our IP is on a deny list. A custom NYCourts-branded Cloudflare page; its "support ID" *is* the `cf-ray`. Does not self-heal |

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

## Egress denied (the IP is blocked)

You got `Request Could Not Be Processed`. **The cookie is irrelevant and no amount of retrying will
help** — do not re-bootstrap `cf_clearance`, and do not force-retry items (they keep their attempt
budget while the cooldown holds them, so there is nothing to rescue yet).

**The rule: datacenter IPs are denied, residential/mobile-class IPs are tolerated.** This is why the
uploader is not on AWS — see [SERVER-DEPLOY.md](SERVER-DEPLOY.md). It also means a free proxy list
will not work: those are datacenter IPs.

1. **Ask OCA to delist the IP.** This is what ended the 2026-09-10 block, and the only way to learn
   which rule fired. Use the support link on the block page with: the `cf-ray` values from the alert
   text, the source IP, the onset window, and what the last successful request looked like. Re-run
   the TL;DR `curl` to detect when they have delisted it.
2. **If it will not be lifted, switch egress** to a paid **residential** proxy — not a VPN or a free
   proxy list, both of which are datacenter egress. Qualify the provider on its trial first:
   ```bash
   curl -s --proxy http://127.0.0.1:8888 https://iapps.courts.state.ny.us/nyscef/Login \
     | grep -oE "Request Could Not Be Processed|Just a moment"
   ```
   The browser honours `PROXY_URL`, but only unauthenticated (Playwright is handed `{ server }`), so
   it has to name a local forward proxy whose upstream is the provider. **The deploy workflow does not
   write `PROXY_URL`** and rewrites `.env` on every merge, so wiring it is a change to `deploy.yml` —
   with `CF_INJECT_COOKIE=false` alongside, since residential exits rotate and `cf_clearance` is bound
   to the IP that earned it. nyscef-ingest fetches NYSCEF documents from this same IP and reads the
   same `PROXY_URL`, so it is blocked too and needs the same proxy.

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

The cooldown probe already arrives clean once per window, which is all a re-bootstrap
([SERVER-DEPLOY.md → Part 5](SERVER-DEPLOY.md#part-5--bootstrap-the-cloudflare-cookie)) does. Read
its outcome in the logs:

- `arriving clean` → `Login page response: status=200` → `Persisted fresh cf_clearance` =
  **success.** The cookie was just stale — 2026-09-14 and 09-23 healed this way within one window.
  Recover any burned items with `forceRetryExhaustedItems` (see below).
- Still `status=403` on **every** clean arrival → the IP or the browser. Load the login page in a
  real Chrome at the office, which shares the server's egress IP:
  - **Chrome gets the login form** → the browser build is flagged; see
    [Browser flagged](#browser-flagged-challenged-even-arriving-clean).
  - **Chrome is challenged too** → the IP. Wait it out first — rate-limit reputation often recovers
    in tens of minutes, and the [cooldown circuit](#the-cooldown-circuit) is already doing this. The
    IP is static and cannot be rotated, so beyond that the options are those under
    [Egress denied](#egress-denied-the-ip-is-blocked).

## Browser flagged (challenged even arriving clean)

Every clean arrival draws the `Just a moment` managed challenge, while a real Chrome from the same IP
goes straight to the login form. Cloudflare is recognising the browser, not the IP or the cookie, so
waiting, re-bootstrapping and proxies change nothing.

On 2026-09-29 (#1976/#1977) it began challenging Playwright's own Chromium — builds 141 and 147 alike —
while passing Google Chrome 153/154 with the same stealth setup from the same IP, which is why the
uploader runs Google Chrome stable. Chrome's version is fixed when the image builds, so a stale Chrome
is the first suspect next time; every launch logs `Launched Google Chrome <version>`.

Test a candidate image **before** deploying it, in a throwaway container with no env — it injects no
cookie and reads no secret (build one with `docker build -t nyscef-uploader:candidate .` from a copy
of the branch):

```bash
docker run --rm --shm-size=1g --entrypoint node nyscef-uploader:candidate --input-type=module -e "
const { initBrowser } = await import('/app/dist/uploader/initBrowser.js');
const { browser, context } = await initBrowser();
const page = await context.newPage();
const r = await page.goto('https://iapps.courts.state.ny.us/nyscef/Login', { waitUntil: 'domcontentloaded' });
console.log('status', r.status(), 'login form', await page.isVisible('#txtUserName'));
await browser.close();"
```

`status 200 login form true` = Cloudflare accepts that browser. `status 403` = production would be
challenged too.

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
| Browser build (Google Chrome stable, fixed at image build) | [Dockerfile](Dockerfile), launched in [src/uploader/initBrowser.ts](src/uploader/initBrowser.ts) |
| Consecutive-failure pager (threshold 3) | [src/helpers/uploadHealth.ts](src/helpers/uploadHealth.ts) |
| Cooldown pause + sustained-outage pager | [src/helpers/cfCooldown.ts](src/helpers/cfCooldown.ts) |
| Force-retry helpers | [src/queue/queueProcessor.ts](src/queue/queueProcessor.ts) |
| Cookie bootstrap procedure | [SERVER-DEPLOY.md Part 5](SERVER-DEPLOY.md) |
| Queue table | `Court.NyscefUploadQueue` |
| Stored cookie | Secrets Manager `nyscef/cf_clearance` |
| Proxy override | env `PROXY_URL` (not written by `deploy.yml` yet) |
| Cooldown window | env `CF_COOLDOWN_MS` (default 600000) |
