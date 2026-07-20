# Filing Miscellaneous Documents to NYSCEF

**What this is:** *any* PDF can be filed to a NYSCEF case — motions, affidavits, correspondence, supporting
paperwork — not just the comp-generator evidence reports. You put the file in S3, send one API call, and it
gets filed automatically.

> **Note:** the request goes to the `evidence-ingest` service (in the `lambdas` repo). This uploader is what
> picks the document up afterwards and files it with the court. The guide lives here because filing behavior
> — document types, duplicate handling — is decided on this side.

---

## The short version

1. Put your PDF in S3 (`aventine-court-docs` is fine).
2. `POST` a JSON payload naming the parcel, the SCAR index number, the year, and where the file lives.
3. The document is queued and filed to NYSCEF within a few minutes.

You never attach the PDF to the request — you point at it in S3.

---

## The request

**POST** `https://mjgkhamb7qcvcpl6d54saqifae0tfqcp.lambda-url.us-east-1.on.aws/`

Authenticated with AWS IAM (SigV4, service `lambda`, region `us-east-1`) — you need an access key and secret key.

```json
{
  "documents": [
    {
      "parcelID": "S0500-345-00-02-00-076-000",
      "scarID": "805323/2025",
      "year": 2026,
      "s3Bucket": "aventine-court-docs",
      "s3Key": "residential/evidence/2026/S0500-345-00-02-00-076-000/805323-2025_motion_to_preclude.pdf",
      "nyscefDocType": "EXHIBIT",
      "description": "Motion to Preclude"
    }
  ],
  "realFrom": "catherine@aventine.ai"
}
```

### Fields

| Field | Required | What it does |
|-------|----------|--------------|
| `parcelID` | Yes | The parcel, e.g. `S0500-345-00-02-00-076-000`. County is derived from the first letter (`S` → Suffolk, `W` → Westchester, `N` → Nassau…). |
| `scarID` | Yes | SCAR index number, e.g. `805323/2025` — used to find the case on NYSCEF. |
| `year` | Yes | **Tax year, not the SCAR filing year.** These differ: SCAR `805323/2025` above is a 2026 tax-year case. |
| `s3Bucket` + `s3Key` | Yes | Where the PDF already lives. **Must be sent together.** |
| `nyscefDocType` | No | `EXHIBIT` (default) or `LETTER`. See below. |
| `description` | No | The exhibit description shown on NYSCEF. Only used for `EXHIBIT`. |
| `exhibitLabelMode` | No | `NUMBER` or `LETTER`. Leave it off — labels resolve automatically. See below. |
| `realFrom` | No | Your email, for the audit trail. |
| `testing` | No | `true` = run the whole pipeline but don't actually file. |
| `forceUpload` | No | `true` = file it even if it looks like a duplicate. |

### Choosing `nyscefDocType`

| Value | Files on NYSCEF as | Use for |
|-------|--------------------|---------|
| `EXHIBIT` *(default)* | `EXHIBIT(S)` — auto-assigned the next letter (A, B, C…) | Motions, affidavits, supporting documents |
| `LETTER` | `LETTER / CORRESPONDENCE TO JUDGE` | Correspondence to the judge |

With `EXHIBIT`, whatever you put in `description` becomes the exhibit description on the filing. Leave it
blank and it just says "Exhibit" — worth filling in.

### Lettered vs. numbered exhibits

Exhibits are **lettered** (A, B, C…) by default. Some judges follow the NY convention of numbering the
petitioner's exhibits (we file as the petitioner) — for those, pass `exhibitLabelMode: "NUMBER"`.

You almost never need to set `exhibitLabelMode`. Labels resolve automatically:

1. If you pass `exhibitLabelMode`, that wins.
2. Otherwise, if **we** already filed exhibits in one style on this case, that style continues (so a case
   doesn't end up with a mixed `A, B, 1` sequence mid-docket).
3. Otherwise, lettering.

Only **our** exhibits count. The opposing party's exhibits neither pick the style nor advance the counter, so
if the assessor filed their "Exhibit A", ours still starts at A. That is expected — each side labels its own
exhibits independently.

> Attribution works by matching the "Filed By" name on NYSCEF against `filerName` in the `nyscef/credentials`
> secret. If that is unset or doesn't match, the uploader logs a warning and falls back to plain lettering.

---

## Example

```bash
curl --aws-sigv4 "aws:amz:us-east-1:lambda" \
  --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
  -X POST "https://mjgkhamb7qcvcpl6d54saqifae0tfqcp.lambda-url.us-east-1.on.aws/" \
  -H "Content-Type: application/json" \
  -d '{
    "documents": [
      {
        "parcelID": "S0500-345-00-02-00-076-000",
        "scarID": "805323/2025",
        "year": 2026,
        "s3Bucket": "aventine-court-docs",
        "s3Key": "residential/evidence/2026/S0500-345-00-02-00-076-000/805323-2025_motion_to_preclude.pdf",
        "nyscefDocType": "EXHIBIT",
        "description": "Motion to Preclude"
      }
    ],
    "testing": true,
    "realFrom": "catherine@aventine.ai"
  }'
```

Start with `"testing": true`. That runs everything except the actual filing. Drop the flag once the payload
looks right.

---

## What you get back

```json
{
  "message": "Evidence queued for NYSCEF upload successfully",
  "queueItemIds": [5780],
  "ingestID": 312
}
```

A `200` means **queued**, not **filed** — the actual NYSCEF filing happens a few minutes later. Keep the
`ingestID` to trace what happened.

A `400` means the request was malformed. A `500` means one or more documents failed; the response lists every
failure, and any documents that *did* succeed are still queued.

---

## Things worth knowing

**You can send several at once.** `documents` is an array — mix parcels, mix document types, and you can even
combine miscellaneous documents and regular evidence reports in the same call.

**The same file can't be filed twice.** The system fingerprints the file's actual contents, so a re-send of an
unchanged file is recognized as a duplicate and will not double-file. A *corrected* version of the file counts
as new and does get filed. Filing the same file as both `EXHIBIT` and `LETTER` counts as two separate filings.

A re-send of an already-queued file returns the original queue ID rather than creating a second entry.
`forceUpload` does **not** override this — it bypasses the uploader's already-filed checks, not the queue's
uniqueness on `(s3Bucket, s3Key)`.

**Don't mix `identifier` and `s3Bucket`/`s3Key`.** `identifier` is for comp-generator evidence reports
(`unequal`, `excessive`, `village`, `training`, `letter`); `s3Bucket` + `s3Key` is for arbitrary documents.
Sending both is rejected on purpose — filing the wrong document with the court is far worse than a failed
request.

**Failures retry themselves.** Up to 3 attempts, then it's flagged for a human.

---

*Questions: Catherine Sangiovanni — catherine@aventine.ai*
