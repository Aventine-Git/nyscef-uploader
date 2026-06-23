# NYSCEF Uploader — Server Deployment Guide

The uploader runs as a Docker container on a local Ubuntu server. You develop on your local
machine and deploy directly to the server using Docker context over SSH — no git clone needed
on the server.

---

## Why a local server instead of Lambda

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

## How deployments work

You never copy source files to the server. Instead, `docker context` lets your local `docker`
commands target the remote Docker daemon over SSH:

```
Your machine (docker CLI + source files)
    │
    │  SSH tunnel (docker context)
    ▼
Server (Docker daemon builds the image, runs the container)
```

Deploy from your local machine:

```bash
docker --context nyscef-server compose up --build -d
```

That's it. Docker sends the build context to the server, builds the image there, and starts
the container. Your `.env` file is read locally and its values are injected into the container
— the server never stores credentials on disk.

---

## Prerequisites

- [ ] SSH access to the server (`ssh server` — configured in `~/.ssh/config`, port 3005)
- [ ] Access to the AWS Console (to create an IAM user)
- [ ] The NYSCEF username and password
- [ ] Your SQS queue URL (AWS Console → SQS → select the queue → copy the URL at the top)

---

## Part 1 — AWS IAM Setup

The container needs AWS credentials to read from SQS, access Secrets Manager, read S3, and
invoke other Lambda functions. Create a dedicated IAM user with only the required permissions.

### Step 1.1 — Create the IAM user

1. Open the AWS Console → **IAM** → **Users** → **Create user**
2. Set the username to `nyscef-uploader-server`
3. On "Set permissions", choose **Attach policies directly**
4. Do **not** attach any managed policies — click **Next** then **Create user**

### Step 1.2 — Attach a custom policy

On the user's page, click **Add permissions** → **Create inline policy** → switch to the **JSON** tab.

Paste this policy (replace `YOUR_ACCOUNT_ID` and `YOUR_QUEUE_NAME` — find your account ID in
the top-right corner of the AWS Console):

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
        "arn:aws:secretsmanager:us-east-1:434028085475:secret:db*",
        "arn:aws:secretsmanager:us-east-1:434028085475:secret:nyscef/cf_clearance*",
        "arn:aws:secretsmanager:us-east-1:434028085475:secret:nyscef/credentials*"
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

### Step 1.2b — Create the NYSCEF credentials secret

1. Open the AWS Console → **Secrets Manager** → **Store a new secret**
2. Choose **Other type of secret**
3. Add two key/value pairs:
   - Key: `username` → Value: your NYSCEF portal username
   - Key: `password` → Value: your NYSCEF portal password
4. Click **Next**, name the secret exactly: `nyscef/credentials`
5. Leave rotation disabled → **Next** → **Store**

### Step 1.3 — Generate access keys

1. On the user's page, click the **Security credentials** tab
2. Click **Create access key**
3. Select **Other** as the use case → **Next** → **Create access key**
4. **Copy both the Access key ID and Secret access key** — you will not be able to see the
   secret key again. Paste them somewhere safe; you'll add them to `.env` next.

> If you close this page without copying the secret key, just delete the key and create a new one.

---

## Part 2 — Server Setup (one-time)

SSH into your server. All commands in this section run on the server.

```bash
ssh server
```

### Step 2.1 — Install Docker

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

Verify it works:

```bash
sudo docker run hello-world
```

### Step 2.2 — Allow running Docker without sudo

```bash
sudo usermod -aG docker $USER
newgrp docker
```

That's all that's needed on the server. You never clone the repo there.

---

## Part 3 — Local Machine Setup (one-time)

These steps run on your **development machine**, not the server.

### Step 3.1 — Create your .env file

In the repo root:

```bash
cp .env.example .env
```

Open `.env` and fill in:

```
AWS_ACCESS_KEY_ID=        ← from Part 1.3
AWS_SECRET_ACCESS_KEY=    ← from Part 1.3
AWS_REGION=us-east-1

NYSCEF_QUEUE_URL=         ← AWS Console → SQS → your queue → copy URL at top

CF_INJECT_COOKIE=true

NOTIFY_RECIPIENTS=catherine@aventine.ai

NOTIFY_SLACK_RECIPIENTS=  ← optional

WARM_START_LOGIN=false
```

The `.env` file is gitignored and never leaves your machine (or CI secrets — see Part 5).

### Step 3.2 — Set up Docker context

```bash
docker context create nyscef-server --docker "host=ssh://server"
```

Verify the connection:

```bash
docker --context nyscef-server info
```

You should see the server's Docker info. If it hangs or errors, check that SSH key auth is
working: `ssh server` should connect without a password prompt.

---

## Part 4 — First Deploy

From your local machine in the repo directory:

```bash
docker --context nyscef-server compose up --build -d
```

**What this does:**
- Sends your local source files to the server's Docker daemon over SSH
- Builds the image on the server (Node.js 22 + Chromium — takes 5–15 min first time)
- Starts the container in the background

Check it started:

```bash
docker --context nyscef-server compose ps
```

Watch the logs:

```bash
docker --context nyscef-server compose logs -f
```

Expected output on a healthy start:
```
[worker] nyscef-uploader worker starting...
[worker] Running scheduled retry of failed items...
No failed items eligible for retry.
[worker] SQS poll loop started. Queue: https://sqs.us-east-1.amazonaws.com/...
```

---

## Part 5 — Bootstrap the Cloudflare Cookie

The `cf_clearance` cookie is tied to the server's IP address. It needs to be earned from
this server the first time.

Check if a cookie already exists:

```bash
aws secretsmanager get-secret-value \
  --secret-id nyscef/cf_clearance \
  --query SecretString \
  --output text \
  --region us-east-1
```

If the output is `{"cf_clearance":""}` or an error, or if it shows a value from the old Lambda
setup, you need to bootstrap a new cookie (the old Lambda's cookie won't work — it's tied to a
different IP).

### Step 5.1 — Trigger a login test

```bash
# Watch logs in one terminal:
docker --context nyscef-server compose logs -f

# In another terminal:
docker --context nyscef-server compose exec nyscef-uploader node -e "
import('./dist/uploader.js').then(m => m.testLogin()).then(() => {
  console.log('Login test complete.');
  process.exit(0);
}).catch(err => {
  console.error('Login test failed:', err.message);
  process.exit(1);
});
"
```

**Expected logs — first run (no cookie):**
```
cf_clearance is empty — arriving clean for this cold start
Cloudflare 503 interstitial — waiting for it to auto-solve...
Successfully logged into NYSCEF
Persisted fresh cf_clearance to Secrets Manager
```

**Expected logs — cookie already exists:**
```
Injected cf_clearance cookie
Login page response: status=200...
Successfully logged into NYSCEF
Persisted fresh cf_clearance to Secrets Manager
```

Either is success. If you see a persistent `403`, see [Troubleshooting](#troubleshooting).

---

## Part 6 — CI/CD with GitHub Actions

Merging a PR to `main` automatically runs tests and deploys to the server. The workflow uses
`rsync` to copy source files to the server, then SSHes in to write the `.env` and run
`docker compose up --build -d`.

The server needs to be reachable from the public internet. Either it has a public IP, or you
have SSH (port 3005) port-forwarded on your router to `192.168.1.160`.

### Step 6.1 — Add GitHub Secrets

In the GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, add:

| Secret | Value |
|--------|-------|
| `DEPLOY_HOST` | server's public IP or hostname |
| `DEPLOY_PORT` | `3005` |
| `DEPLOY_USER` | `cat` |
| `DEPLOY_PASSWORD` | server login password |
| `AWS_ACCESS_KEY_ID` | from Part 1.3 |
| `AWS_SECRET_ACCESS_KEY` | from Part 1.3 |
| `AWS_REGION` | `us-east-1` |
| `NYSCEF_QUEUE_URL` | your SQS queue URL |
| `NOTIFY_RECIPIENTS` | `catherine@aventine.ai` |
| `NOTIFY_SLACK_RECIPIENTS` | optional, leave empty |

### Step 6.2 — Create the deploy directory on the server

SSH into the server and create the directory:

```bash
sudo mkdir -p /opt/nyscef-uploader
sudo chown cat:cat /opt/nyscef-uploader
```

### How it works

On every merged PR to `main`:

1. Unit tests run (`npm test`)
2. Source files are `rsync`'d to `/opt/nyscef-uploader/` on the server (`.env` excluded)
3. An SSH session writes the `.env` from secrets, then runs `docker compose up --build -d`

---

## Part 7 — Auto-Start on Boot

The `restart: unless-stopped` directive in `docker-compose.yml` handles container restarts.
Docker starts on boot automatically on Ubuntu:

```bash
sudo systemctl is-enabled docker
# Should output: enabled
```

No extra configuration needed — the service survives reboots.

---

## Deploying Updates Manually

If you need to deploy without going through CI (e.g. hotfix):

```bash
cd ~/path/to/nyscef-uploader
docker --context nyscef-server compose up --build -d
```

---

## Troubleshooting

### View logs

```bash
docker --context nyscef-server compose logs --tail=100
docker --context nyscef-server compose logs -f
docker --context nyscef-server compose logs --since="2026-06-10T10:00:00"
```

### Container won't start

```bash
docker --context nyscef-server compose logs
```

Common causes:
- Missing or malformed `.env` on the machine that ran the deploy
- `NYSCEF_QUEUE_URL` not set
- AWS credentials wrong (`UnrecognizedClientException` / `InvalidClientTokenId`)

### Cloudflare 403 errors

```
Login page response: status=403...
Cleared stale cf_clearance from Secrets Manager
```

The code clears the bad cookie automatically. The next poll cycle bootstraps a fresh one via
the 503 interstitial path. If 403s persist for more than 2–3 retries, run the login test
manually (Part 5.1).

### NYSCEF password needs reset

Reset the password at the NYSCEF portal, then update it in Secrets Manager:

1. AWS Console → **Secrets Manager** → `nyscef/credentials` → **Retrieve secret value** → **Edit**
2. Update the `password` value → **Save**

No container restart needed — credentials are fetched on each login attempt.

### Queue items stuck in PROCESSING

Reset automatically after 15 minutes. Force an immediate reset:

```bash
docker --context nyscef-server compose restart
```

### Force-retry exhausted items

```bash
docker --context nyscef-server compose exec nyscef-uploader node -e "
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
docker --context nyscef-server compose stop
docker --context nyscef-server compose start
docker --context nyscef-server compose down
docker --context nyscef-server compose down --rmi local   # also removes the image
```

### Check resource usage

```bash
docker --context nyscef-server stats
```

---

## Appendix: SQS Visibility Timeout

Set to **30 minutes** to prevent duplicate attempts on long uploads.

AWS Console → SQS → select your queue → **Edit** → set "Visibility timeout" to `1800` seconds.

---

## Appendix: What Each File Does

| File | Purpose |
|------|---------|
| `src/worker.ts` | Entry point — long-running SQS poller + retry scheduler |
| `Dockerfile` | Instructions for building the container image |
| `docker-compose.yml` | Container configuration (env file, restart policy, logging) |
| `.env.example` | Template — copy to `.env` and fill in credentials |
| `.env` | Your actual credentials (gitignored — never committed) |
| `.github/workflows/deploy.yml` | CI/CD — runs tests then deploys on PR merge to main |
| `src/index.ts` | Original Lambda handler — kept for Lambda compatibility, not used by the worker |

---

## Appendix: Architecture

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
