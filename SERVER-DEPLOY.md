# NYSCEF Uploader — Server Deployment Guide

This guide walks you through moving the `nyscef-uploader` from AWS Lambda to a Docker container
running on a local Ubuntu server. You don't need prior Docker experience — every step is explained.

---

## Why this is better than Lambda

The Lambda approach required a VPC + NAT Gateway + Elastic IP to give Lambda a fixed outbound IP
(so the Cloudflare `cf_clearance` cookie would be valid). That VPC setup was fragile and expensive.

A local server with a fixed IP **is exactly what we needed all along**:

| | Lambda | This server |
|---|---|---|
| Fixed IP | Required VPC + NAT Gateway | Built in — server IP is fixed |
| Cold starts | Every ~15 min → browser restarts, Cloudflare challenge | None — browser runs continuously |
| Memory limits | 1-3 GB cap, crashes Chromium | No cap |
| Execution timeout | 15 min hard limit | None |
| Complexity | VPC, subnets, security groups, NAT | Just Docker |

---

## What changes

### What the Lambda did (old)
- AWS received an SQS message → automatically invoked the Lambda with that message
- AWS EventBridge ran the Lambda on a schedule to retry failed items

### What the container does (new)
- A long-running Node.js process **polls SQS itself** (asking "any new messages?" every 20 seconds)
- A built-in timer runs the retry logic every 15 minutes
- Everything else (Playwright, database, S3, Secrets Manager, invoking other Lambdas) is unchanged

The new entry point is `src/worker.ts`. The existing upload logic, queue client, and emailer code
are not modified at all.

---

## Prerequisites

Before you start, you'll need:

- [ ] SSH access to the server (you have this)
- [ ] Access to the AWS Console (to create an IAM user)
- [ ] The NYSCEF username and password
- [ ] To know your SQS queue URL (AWS Console → SQS → select the queue → copy the URL at the top)

---

## Part 1 — AWS IAM Setup

The server needs AWS credentials to read from SQS, access Secrets Manager, read S3, and invoke
other Lambda functions. We create a dedicated IAM user with only the required permissions.

### Step 1.1 — Create the IAM user

1. Open the AWS Console → **IAM** → **Users** → **Create user**
2. Set the username to `nyscef-uploader-server`
3. On "Set permissions", choose **Attach policies directly**
4. Do **not** attach any managed policies yet — click **Next** then **Create user**

### Step 1.2 — Attach a custom policy

On the user's page, click **Add permissions** → **Create inline policy** → switch to the **JSON** tab.

Paste this policy (replace `YOUR_ACCOUNT_ID` and `YOUR_QUEUE_NAME` with your actual values —
find your account ID in the top-right corner of the AWS Console):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SQSAccess",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ChangeMessageVisibility"
      ],
      "Resource": "arn:aws:sqs:us-east-1:YOUR_ACCOUNT_ID:YOUR_QUEUE_NAME"
    },
    {
      "Sid": "SecretsRead",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": [
        "arn:aws:secretsmanager:us-east-1:YOUR_ACCOUNT_ID:secret:db*",
        "arn:aws:secretsmanager:us-east-1:YOUR_ACCOUNT_ID:secret:nyscef/cf_clearance*"
      ]
    },
    {
      "Sid": "SecretsWriteCfCookie",
      "Effect": "Allow",
      "Action": ["secretsmanager:PutSecretValue"],
      "Resource": "arn:aws:secretsmanager:us-east-1:YOUR_ACCOUNT_ID:secret:nyscef/cf_clearance*"
    },
    {
      "Sid": "S3ReadDocuments",
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": [
        "arn:aws:s3:::aventine-court-docs/*",
        "arn:aws:s3:::evidence-ingest-files/*",
        "arn:aws:s3:::stipulation-ingest-files/*",
        "arn:aws:s3:::aventine-gmail-public/*"
      ]
    },
    {
      "Sid": "S3WriteScreenshots",
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::aventine-court-docs/screenshots/*"
    },
    {
      "Sid": "LambdaInvokeNotifiers",
      "Effect": "Allow",
      "Action": ["lambda:InvokeFunction"],
      "Resource": [
        "arn:aws:lambda:us-east-1:YOUR_ACCOUNT_ID:function:notifier",
        "arn:aws:lambda:us-east-1:YOUR_ACCOUNT_ID:function:gmail-sender"
      ]
    }
  ]
}
```

Click **Next**, name the policy `nyscef-uploader-server-policy`, then **Save changes**.

### Step 1.3 — Generate access keys

1. On the user's page, click the **Security credentials** tab
2. Click **Create access key**
3. Select **Other** as the use case → **Next** → **Create access key**
4. **Copy both the Access key ID and Secret access key** — you will not be able to see the
   secret key again. Paste them somewhere safe temporarily; you'll add them to the `.env` file.

> If you close this page without copying the secret key, just delete the key and create a new one.

---

## Part 2 — Server Setup

SSH into your server. All commands in this section run on the server.

```bash
ssh your-user@your-server-ip
```

### Step 2.1 — Install Docker

Docker is the software that runs containers. These commands install the official Docker package
for Ubuntu 24.04:

```bash
# Add Docker's official GPG key
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Verify Docker is working:

```bash
sudo docker run hello-world
```

You should see: `Hello from Docker!`

### Step 2.2 — Allow running Docker without sudo (optional but convenient)

```bash
sudo usermod -aG docker $USER
newgrp docker
```

After this, you can run `docker` commands without `sudo`.

### Step 2.3 — Clone the repository

```bash
# If git is not installed:
sudo apt-get install -y git

# Clone the repo (you may need to set up SSH keys or use HTTPS with a personal access token)
git clone git@github.com:Aventine-Git/lambdas.git ~/lambdas
```

If you use HTTPS and get prompted for a password, you'll need a GitHub personal access token
(not your account password). Create one at GitHub → Settings → Developer settings →
Personal access tokens.

---

## Part 3 — Configure the Environment

### Step 3.1 — Create the .env file

Navigate to the nyscef-uploader directory and create the environment file:

```bash
cd ~/lambdas/nyscef-uploader
cp .env.example .env
nano .env
```

Fill in each value:

```
AWS_ACCESS_KEY_ID=        ← paste the access key ID from Part 1
AWS_SECRET_ACCESS_KEY=    ← paste the secret access key from Part 1
AWS_REGION=us-east-1

NYSCEF_QUEUE_URL=         ← paste the SQS URL (AWS Console → SQS → your queue → copy URL at top)

NYSCEF_USERNAME=          ← NYSCEF portal username
NYSCEF_PASSWORD=          ← NYSCEF portal password

CF_INJECT_COOKIE=true     ← leave as true — server has a fixed IP, this is correct

NOTIFY_RECIPIENTS=catherine@aventine.ai

NOTIFY_SLACK_RECIPIENTS=  ← optional, leave blank if unsure

WARM_START_LOGIN=false    ← leave false for now; set true later if you want browser pre-warmed
```

Save and close: `Ctrl+O`, `Enter`, `Ctrl+X`.

### Step 3.2 — Protect the .env file

The `.env` file contains credentials. Restrict who can read it:

```bash
chmod 600 .env
```

The `.env` file is already in `.gitignore` so it won't be committed accidentally.

---

## Part 4 — Build and Start the Container

### Step 4.1 — Build the Docker image

From the `nyscef-uploader/` directory:

```bash
cd ~/lambdas/nyscef-uploader
docker compose build
```

**What this does:**
- Reads the `Dockerfile` in this directory
- Creates a container image with Node.js 22, all npm packages, TypeScript compiled,
  and a full Chromium browser installed
- This takes 5–15 minutes the first time (Chromium download is ~300 MB)
- Subsequent builds are much faster because Docker caches each step

You should see output ending with something like `Successfully built` or `nyscef-uploader built`.

> If you see "permission denied" errors, run `newgrp docker` or log out and back in, then retry.

### Step 4.2 — Start the container

```bash
docker compose up -d
```

The `-d` flag means "detached" — it runs in the background so you can close your SSH session
and it keeps running.

### Step 4.3 — Check that it started

```bash
docker compose ps
```

You should see `nyscef-uploader` with status `running`.

### Step 4.4 — Watch the logs

```bash
docker compose logs -f
```

Press `Ctrl+C` to stop watching (the container keeps running).

Expected output on a healthy start:
```
[worker] nyscef-uploader worker starting...
[worker] Running scheduled retry of failed items...
No failed items eligible for retry.
[worker] SQS poll loop started. Queue: https://sqs.us-east-1.amazonaws.com/...
```

If you see errors here, see the [Troubleshooting](#troubleshooting) section.

---

## Part 5 — Bootstrap the Cloudflare Cookie

The `cf_clearance` cookie is what lets the browser skip Cloudflare's bot check. It's tied to the
server's IP address, so we need to earn one from this server the first time.

**Check if a cookie already exists from the old Lambda setup:**

```bash
# Run this in a different terminal (not inside the container)
aws secretsmanager get-secret-value \
  --secret-id nyscef/cf_clearance \
  --query SecretString \
  --output text \
  --region us-east-1 \
  --profile default
```

If the output is `{"cf_clearance":""}` or you get an error, you need to bootstrap a new cookie.
If it shows a long cookie value, it was stored by the old Lambda — it's **not valid for this
server's IP** and needs to be replaced. Continue with Step 5.1.

### Step 5.1 — Trigger a login test

The login test launches the browser, goes to NYSCEF, logs in, and saves the resulting cookie to
Secrets Manager automatically. It uses this server's IP, so the cookie will work for all future
requests.

```bash
# Watch the logs in one terminal:
docker compose logs -f

# In another terminal, run the login test:
docker compose exec nyscef-uploader node -e "
import('./dist/uploader.js').then(m => m.testLogin()).then(() => {
  console.log('Login test complete.');
  process.exit(0);
}).catch(err => {
  console.error('Login test failed:', err.message);
  process.exit(1);
});
"
```

**What you should see in the logs:**

**First run (no existing cookie) — this is normal:**
```
cf_clearance is empty — arriving clean for this cold start
Cloudflare 503 interstitial — waiting for it to auto-solve...
Successfully logged into NYSCEF
Persisted fresh cf_clearance to Secrets Manager
```

**Already has a cookie injected:**
```
Injected cf_clearance cookie
Login page response: status=200...
Successfully logged into NYSCEF
Persisted fresh cf_clearance to Secrets Manager
```

Either result is success. The cookie is now saved for this server's IP.

**If you see a 403:**
```
Login page response: status=403...
Cloudflare challenge (status=403 ...
```

This means the server's IP may be in a datacenter range that Cloudflare hard-blocks. Try running
the login test once more — sometimes the first attempt from a new IP gets a challenge that resolves
on the second attempt:

```bash
# Run the login test command again
```

If 403s persist after 2–3 attempts, the IP needs to be investigated. Contact Cloudflare-unblocking
options (residential proxy). This is the same situation documented in
[CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md) under "Fallback — Residential Proxy".

---

## Part 6 — Verify an End-to-End Upload

At this point the worker is running and polling SQS. The simplest verification is to queue a test
item the same way `stipulation-ingest` or `evidence-ingest` does, and watch it process.

You can also check the database directly:

```bash
# Check recent queue items
# (run via your MySQL client or the ingest-debug skill)
SELECT ID, Status, ParcelID, DocumentType, Attempts, ErrorMessage, UpdatedAt
FROM Court.NyscefUploadQueue
ORDER BY UpdatedAt DESC
LIMIT 10;
```

If you see items moving from `QUEUED` → `PROCESSING` → `UPLOADED`, everything is working.

---

## Part 7 — Auto-Start on Boot

The `restart: unless-stopped` directive in `docker-compose.yml` means the container automatically
restarts if it crashes or if Docker itself is restarted. Docker is set to start on boot
automatically when installed on Ubuntu, so the service survives reboots without any extra
configuration.

To verify Docker starts on boot:

```bash
sudo systemctl is-enabled docker
# Should output: enabled
```

---

## Part 8 — Deploying Updates

When code changes in the repo (new features, bug fixes), here's how to update the running service:

```bash
cd ~/lambdas

# Pull the latest code
git pull

# Rebuild the image and restart with zero-downtime replacement
cd nyscef-uploader
docker compose up --build -d
```

Docker will build a new image, stop the old container, and start a new one. The queue keeps any
in-flight messages visible until the visibility timeout expires, so nothing is lost during the
restart.

> The `--build` flag forces a rebuild even if Docker thinks nothing changed. Always include it
> when deploying code updates.

---

## Troubleshooting

### View logs

```bash
# Recent logs (last 100 lines)
docker compose logs --tail=100

# Follow live
docker compose logs -f

# Logs since a specific time
docker compose logs --since="2026-06-10T10:00:00"
```

### Container won't start

```bash
# Check for error output
docker compose logs

# Common causes:
# - Missing or malformed .env file
# - NYSCEF_QUEUE_URL not set
# - AWS credentials not working
```

If you see `NYSCEF_QUEUE_URL is not set`, open `.env` and make sure the value is filled in with
no extra spaces.

If you see AWS errors (`UnrecognizedClientException`, `InvalidClientTokenId`), your
`AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` is wrong. Double-check them against the values
in the AWS Console.

### Cloudflare 403 errors

```
Login page response: status=403...
Cleared stale cf_clearance from Secrets Manager
```

The stored cookie is stale for this IP. The code clears it automatically. The next poll cycle
will arrive with no cookie and attempt to pass the 503 interstitial. Watch the logs for:

```
Cloudflare 503 interstitial — waiting for it to auto-solve...
Successfully logged into NYSCEF
Persisted fresh cf_clearance to Secrets Manager
```

If 403s persist for more than 2–3 retries, run the login test manually (Step 5.1) to force a
fresh bootstrap. If that also 403s, the IP may be hard-blocked.

### NYSCEF password needs reset

```
Error: NYSCEF password needs to be reset.
```

Reset the NYSCEF password manually at the portal, then update `NYSCEF_PASSWORD` in `.env`:

```bash
nano .env
# Update NYSCEF_PASSWORD=new_password
# Save and exit

docker compose up -d  # restarts with new env
```

### Queue items stuck in PROCESSING

Items are automatically reset to FAILED after 15 minutes in PROCESSING. The retry scheduler
runs every 15 minutes and will pick them up. You can check in the database:

```sql
SELECT * FROM Court.NyscefUploadQueue
WHERE Status = 'PROCESSING'
AND UpdatedAt < NOW() - INTERVAL 15 MINUTE;
```

If you need to force a retry immediately, restart the container (which triggers the startup
retry run):

```bash
docker compose restart
```

### Force-retry exhausted items

Items that have failed 3 times stop being retried automatically. To retry them anyway:

```bash
docker compose exec nyscef-uploader node -e "
import('./dist/queue/queueProcessor.js').then(m => m.forceRetryAllItems()).then(() => {
  console.log('Force retry complete.');
  process.exit(0);
}).catch(err => {
  console.error(err.message);
  process.exit(1);
});
"
```

### Stop / restart / remove the container

```bash
# Stop without removing
docker compose stop

# Start again
docker compose start

# Stop and remove (image is preserved)
docker compose down

# Stop, remove, and remove the image too (next start will rebuild)
docker compose down --rmi local
```

### Check container resource usage

```bash
docker stats
```

Shows CPU, memory, and network usage in real-time. Press `Ctrl+C` to exit.

---

## Appendix: SQS Queue Visibility Timeout

The SQS visibility timeout controls how long a message stays invisible after being received.
If your upload takes longer than the timeout, the message becomes visible again while you're
still processing it — causing a duplicate attempt.

Recommended: set the visibility timeout to **30 minutes**.

To check/update in the AWS Console:
1. SQS → select your queue → **Edit**
2. Find "Visibility timeout" — set to `1800` seconds (30 minutes)
3. **Save**

---

## Appendix: What Each File Does

| File | Purpose |
|------|---------|
| `src/worker.ts` | New entry point — long-running SQS poller + retry scheduler |
| `Dockerfile` | Instructions for building the container image |
| `docker-compose.yml` | Configuration for running the container (env file, restart policy, logging) |
| `.env.example` | Template — copy to `.env` and fill in credentials |
| `.env` | Your actual credentials (never commit this file) |
| `src/index.ts` | Original Lambda handler — kept for Lambda compatibility, not used by the server |

---

## Appendix: Architecture Diagram

```
[evidence-ingest / stipulation-ingest Lambda]
         │
         │ sends SQS message { id: 123 }
         ▼
[SQS Queue: NYSCEF_QUEUE]
         │
         │ polled every 20 seconds
         ▼
[nyscef-uploader container on your server]
    ├── polls SQS (aws-sdk/client-sqs)
    ├── reads PDF from S3 (aws-sdk/client-s3)
    ├── reads DB creds from Secrets Manager
    ├── reads/writes cf_clearance cookie in Secrets Manager
    ├── connects to MySQL database
    ├── launches Chromium → logs into NYSCEF → uploads PDF
    ├── invokes notifier Lambda (Slack + email notification)
    └── retries failed items every 15 minutes
```

---

*Guide written June 2026 — Catherine Sangiovanni*
