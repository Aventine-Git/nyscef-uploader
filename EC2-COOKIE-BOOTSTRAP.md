# NYSCEF Uploader — EC2 Cookie Bootstrap

## What this is for

The Lambda gets Cloudflare 403 errors on cold starts because its browser can't solve Cloudflare's
managed challenge automatically. Once a valid `cf_clearance` cookie exists in Secrets Manager for
the Lambda's fixed IP, every cold start injects it and skips the challenge entirely.

This guide gets that first cookie by running a browser on a temporary EC2 instance that shares
the Lambda's outbound IP address (the NAT Gateway Elastic IP). Cloudflare sees the same IP from
the EC2 as it does from the Lambda — so a cookie earned here is valid for the Lambda too.

**Cost:** ~$0.01 (a few minutes of t3.micro time). Terminate the EC2 when done.

**When to use this:**
- First-time setup after the VPC + NAT Gateway is in place
- After the `cf_clearance` cookie expires (~1 year) and auto-renewal isn't working
- Any time cold starts are 403-ing and Secrets Manager shows an empty cookie

---

## Prerequisites

- VPC + NAT Gateway + Elastic IP set up per [CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md)
- `CF_INJECT_COOKIE=true` set in the Lambda's environment variables
- AWS Console access

---

## Step 1 — Create an IAM role for the EC2

This lets us connect to the EC2 through the browser without SSH keys.

IAM → Roles → **Create role**

| Field | Value |
|-------|-------|
| Trusted entity type | AWS service |
| Use case | EC2 |
| Permissions policy | `AmazonSSMManagedInstanceCore` |
| Role name | `ec2-ssm-role` |

Click **Create role**.

> `AmazonSSMManagedInstanceCore` is the AWS-managed policy that allows Systems Manager Session
> Manager to connect to an EC2 instance. It's the only permission this role needs.

---

## Step 2 — Launch the EC2

EC2 → **Launch instances**

| Field | Value |
|-------|-------|
| Name | `nyscef-cookie-helper` |
| AMI | Amazon Linux 2023 (default) |
| Instance type | `t3.micro` |
| Key pair | Proceed without a key pair |
| VPC | `nyscef-vpc` |
| Subnet | `nyscef-private` ← must be the private subnet |
| Auto-assign public IP | **Disable** |
| Security group | `nyscef-lambda-sg` |
| IAM instance profile | `ec2-ssm-role` |

Click **Launch instance** and wait ~1 minute for the status to show **Running**.

> **Why the private subnet?** Resources in the private subnet route outbound traffic through the
> NAT Gateway, which means Cloudflare sees the same fixed Elastic IP as the Lambda. A public
> subnet EC2 with its own public IP would have a different address entirely — defeating the point.

> **Why no public IP or key pair?** We connect through AWS Systems Manager Session Manager, which
> creates an encrypted tunnel through AWS's own infrastructure. No SSH port, no exposed IP, no
> keys to manage.

---

## Step 3 — Connect to the EC2

EC2 → Instances → select `nyscef-cookie-helper` → **Connect** (top right)

Click the **Session Manager** tab → **Connect**

A terminal opens in your browser. You're now running commands inside the EC2, whose outbound
traffic exits through the Lambda's Elastic IP.

> If the Connect button is greyed out or Session Manager shows an error, wait another minute.
> The SSM agent needs ~60 seconds on first boot to register with AWS.

---

## Step 4 — Install dependencies

Paste this entire block into the terminal. It installs Node.js 22, Playwright, and a headless
Chromium browser with all required system libraries:

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && \
sudo dnf install -y nodejs && \
cd /tmp && mkdir nyscef-test && cd nyscef-test && \
npm init -y && \
npm pkg set type=module && \
npm install playwright-extra puppeteer-extra-plugin-stealth && \
npx playwright install --with-deps chromium
```

This takes about 2–3 minutes. Wait for the command prompt to return before continuing.

---

## Step 5 — Run the test script

Paste this entire block. It creates the script and runs it immediately:

```bash
cat > test.mjs << 'EOF'
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  viewport: { width: 1920, height: 1080 }
});
const page = await context.newPage();

console.log('Navigating to NYSCEF login...');
await new Promise(res => setTimeout(res, 3000));

const response = await page.goto('https://iapps.courts.state.ny.us/nyscef/Login', {
  waitUntil: 'domcontentloaded',
  timeout: 30000
});

const status = response?.status();
console.log(`Status: ${status}, URL: ${page.url()}`);

if (status === 503) {
  console.log('503 interstitial — waiting for auto-solve (up to 15s)...');
  const solved = await page
    .waitForSelector('#txtUserName', { state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  console.log(solved ? '503 cleared!' : '503 did not clear within 15s');
}

if (page.url().includes('__cf_chl') || status === 403) {
  console.log('\n❌ Hard 403 block — this IP is flagged by Cloudflare.');
  console.log('   The Elastic IP is in a datacenter range Cloudflare permanently blocks.');
  console.log('   Next step: residential proxy (see CLOUDFLARE-SETUP.md Fallback section).');
} else {
  const cookies = await context.cookies('https://iapps.courts.state.ny.us');
  const cf = cookies.find(c => c.name === 'cf_clearance');
  if (cf) {
    console.log('\n✅ Got cf_clearance cookie — paste this into Secrets Manager:');
    console.log(JSON.stringify({ cf_clearance: cf.value }));
  } else {
    console.log('\n⚠️  Reached the login page but no cf_clearance cookie was issued.');
    console.log('   Re-run: node test.mjs');
    console.log('   The second attempt from the same IP usually gets through cleanly.');
  }
}

await browser.close();
EOF
node test.mjs
```

---

## Step 6 — Read the result

### ✅ Success

Output will include:
```
✅ Got cf_clearance cookie — paste this into Secrets Manager:
{"cf_clearance":"AbCdEf1234...very long string..."}
```

1. Copy the entire `{"cf_clearance":"..."}` JSON string
2. Go to Secrets Manager → Secrets → `nyscef/cf_clearance`
3. **Retrieve secret value → Edit** → paste the JSON → **Save**
4. Terminate the EC2 (Step 7)
5. Run `{ "_loginTest": true }` on the Lambda — you should see:
   ```
   Injected cf_clearance cookie
   Login page response: status=200...
   Successfully logged into NYSCEF
   ```

### ⚠️ No cookie but no 403 either

The challenge cleared but Cloudflare didn't issue a cookie yet. Run the script again:
```bash
node test.mjs
```
The second request from the same IP usually gets straight through and receives the cookie.

### ❌ Hard 403

```
❌ Hard 403 block — this IP is flagged by Cloudflare.
```

The Elastic IP is in a datacenter range that Cloudflare hard-blocks on this site. The cookie
approach won't work from any AWS IP. Follow the **Fallback — Residential Proxy** section in
[CLOUDFLARE-SETUP.md](CLOUDFLARE-SETUP.md).

---

## Step 7 — Terminate the EC2

Once you have your result, terminate the instance — there's no reason to leave it running.

EC2 → Instances → `nyscef-cookie-helper` → **Instance state → Terminate instance**

Confirm termination. The instance and its storage are deleted immediately.

> The `ec2-ssm-role` IAM role can stay — it's reusable if you need to run this process again
> when the cookie expires.
