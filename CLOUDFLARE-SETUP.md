# NYSCEF Uploader — Cloudflare Fix Setup

## What's actually happening (read this first)

### The problem in plain English

When our uploader Lambda tries to log into NYSCEF, it has to get past Cloudflare — a security
service that sits in front of the NYSCEF login page and blocks automated browsers (bots).

Cloudflare issues a special cookie called `cf_clearance` to browsers that pass its check. Think
of it like a wristband at a venue: once you've been checked at the door, you wear the wristband
so you don't have to go through the line again.

**The catch:** Cloudflare ties this wristband to your exact IP address. If you show up at the
door with someone else's wristband — or with your own wristband but from a different door — it's
rejected, and you get a hard block (HTTP 403).

### Why the Lambda keeps failing on cold starts

A **cold start** happens when AWS spins up a fresh container to run the Lambda. Think of it like
renting a new computer from a pool — each one has a different IP address, assigned randomly from
AWS's shared pool of millions of addresses. A **warm start** (reusing an already-running
container) works fine because the browser is still logged in and hasn't needed to show the
wristband again.

The problem:
- Cold start → new container → new IP address → we inject the stored `cf_clearance` cookie →
  Cloudflare sees a valid wristband but the wrong IP → hard block (403)
- Without injection → no wristband at all → Cloudflare challenges us anyway → also a block

We can't win with a shared IP pool. The stored cookie can never be valid for whichever random
IP we land on.

It recently got worse because Cloudflare tightened their protection on `iapps.courts.state.ny.us`.
AWS datacenter IPs that used to get a solvable "checking your browser" interstitial (503) now
immediately get the hard 403 block.

### The fix

We give the Lambda a **fixed, permanent IP address** by routing all its outbound traffic through
a NAT Gateway with an Elastic IP attached. Every container — whether it's a cold start or warm
start — will appear to Cloudflare as the same IP. Once we've earned the `cf_clearance` cookie
for that IP once, it's stored and injected on every subsequent cold start. The wristband works
because the IP never changes.

### The pieces we're setting up

```
Lambda (private subnet)
    │
    ▼  outbound traffic
NAT Gateway (public subnet)
    │
    ▼  all traffic exits here with...
Elastic IP  ←── this is the fixed IP Cloudflare sees
    │
    ▼
Internet → NYSCEF → Cloudflare check → login succeeds
```

Here's what each AWS piece does:

- **VPC (Virtual Private Cloud):** A private, isolated section of the AWS network that belongs
  to us. Like a private office building — we control who's inside and how they connect to the
  outside.

- **Private subnet:** Where the Lambda lives. It has no direct internet access — all outbound
  traffic must go through the NAT Gateway. This is intentional: a Lambda doesn't need to be
  reachable from the internet, it just needs to reach out.

- **Public subnet:** Where the NAT Gateway lives. This subnet does have direct internet access
  via the Internet Gateway.

- **Internet Gateway:** The VPC's connection to the internet. Analogous to the building's front
  door. Required before anything inside the VPC can reach the outside world.

- **NAT Gateway (Network Address Translation Gateway):** Sits in the public subnet and forwards
  outbound traffic from the private subnet to the internet, replacing the source IP with its own
  fixed IP. The Lambda never touches the internet directly — the NAT Gateway is the one actually
  making the connection, and it always uses the same address.

- **Elastic IP:** A static public IP address that you rent from AWS and attach to the NAT
  Gateway. Unlike the random IPs Lambda normally gets, this one is yours permanently until you
  release it. This is the IP Cloudflare will see and associate with our `cf_clearance` cookie.

- **Route Table:** A set of rules that tells traffic inside a subnet where to go. We'll tell
  the private subnet "send everything outbound to the NAT Gateway" and tell the public subnet
  "send everything outbound to the Internet Gateway."

- **Security Group:** A firewall rule attached to the Lambda. We only need outbound rules
  (Lambda reaches out; nothing reaches in).

- **Secrets Manager (`nyscef/cf_clearance`):** AWS's secure key-value store where we save the
  `cf_clearance` cookie value between invocations. When a cold start spins up, the Lambda reads
  this secret, injects the cookie into the browser before navigating to NYSCEF, and Cloudflare
  sees a valid wristband for the fixed IP.

- **`CF_INJECT_COOKIE=true`:** An environment variable that tells the Lambda to use this
  inject-from-Secrets-Manager approach. It was always in the code but disabled, because it only
  makes sense when we have a fixed IP (which we're now setting up).

---

## Part 1 — AWS Console: VPC + NAT Gateway + Elastic IP

> **Where to start:** Log into the [AWS Console](https://console.aws.amazon.com), make sure
> you're in **us-east-1** (top-right region selector), and navigate to **VPC** in the services
> search bar.

---

### Step 1 — Create a VPC

*We need a private network to put the Lambda inside so we can control its outbound IP.*

VPC → Your VPCs → **Create VPC**

| Field | Value |
|-------|-------|
| Name tag | `nyscef-vpc` |
| IPv4 CIDR block | `10.0.0.0/16` |
| Tenancy | Default |

> **What is `10.0.0.0/16`?** This is a private IP address range reserved for internal networks
> (like `192.168.x.x` on a home router). The `/16` means we have 65,536 possible addresses to
> assign to things inside the VPC. We'll only use a tiny fraction of them.

---

### Step 2 — Create two subnets (in the same Availability Zone)

*Subnets are subdivisions of the VPC. We need two: one where the Lambda lives (private, no
direct internet) and one where the NAT Gateway lives (public, has internet access).*

VPC → Subnets → **Create subnet**

Do this **twice** — once for each row below:

| | Public subnet | Private subnet |
|-|--------------|----------------|
| VPC | `nyscef-vpc` | `nyscef-vpc` |
| Subnet name | `nyscef-public` | `nyscef-private` |
| Availability Zone | `us-east-1a` | `us-east-1a` — **must match** |
| IPv4 CIDR block | `10.0.0.0/24` | `10.0.1.0/24` |

> **Why the same Availability Zone?** An Availability Zone (AZ) is a physical data center
> building. The NAT Gateway must be in the same AZ as the Lambda's subnet, or traffic between
> them incurs cross-AZ fees and added latency. `us-east-1a` is fine — we don't need multi-AZ
> redundancy here.

> **What is `/24`?** Each subnet gets 256 addresses. The two subnets (`10.0.0.0/24` and
> `10.0.1.0/24`) are non-overlapping slices of the `/16` VPC range.

---

### Step 3 — Create and attach an Internet Gateway

*The Internet Gateway is the VPC's connection to the public internet. Without it, nothing inside
the VPC can reach the outside world at all — not even the NAT Gateway.*

VPC → Internet Gateways → **Create internet gateway**
- Name tag: `nyscef-igw`
- Click **Create internet gateway**

Then immediately: **Actions → Attach to VPC → select `nyscef-vpc` → Attach**

> The Internet Gateway itself doesn't have an IP — it's just the door. Traffic still needs a
> route table entry to know to use it (next step).

---

### Step 4 — Route the public subnet through the Internet Gateway

*A route table is like a GPS instruction set for traffic. We need to tell the public subnet
"when sending traffic anywhere on the internet, use the Internet Gateway."*

VPC → Route Tables → **Create route table**
- Name: `nyscef-public-rt`
- VPC: `nyscef-vpc`
- Click **Create route table**

Select the new route table → **Routes tab → Edit routes → Add route:**
- Destination: `0.0.0.0/0`
- Target: Internet Gateway → `nyscef-igw`
- Click **Save changes**

Still on the same route table → **Subnet associations tab → Edit subnet associations:**
- Check `nyscef-public`
- Click **Save associations**

> **What is `0.0.0.0/0`?** This means "any destination" — a catch-all rule. Any traffic that
> doesn't match a more specific route gets sent to the Internet Gateway. This is standard for
> any subnet that needs internet access.

---

### Step 5 — Allocate an Elastic IP

*This is the fixed, permanent IP address that the NAT Gateway will use. This is the IP
Cloudflare will see and associate with our cookie.*

VPC → Elastic IPs → **Allocate Elastic IP address**
- Network border group: `us-east-1`
- Click **Allocate**

> **Record this IP address** — you'll see it listed in the Elastic IPs table. Write it down.
> This is the fixed egress IP Cloudflare will see for every Lambda invocation going forward.

> **What's an Elastic IP?** A static public IP address that AWS reserves for you. Unlike the
> ephemeral IPs normally assigned to AWS resources (which change when you stop and start
> something), an Elastic IP stays the same until you explicitly release it. It costs a small
> amount if it's allocated but not attached to anything, so we'll attach it to the NAT Gateway
> right away.

---

### Step 6 — Create a NAT Gateway

*The NAT Gateway is the key piece. It sits in the public subnet, receives outbound traffic from
the Lambda in the private subnet, and forwards it to the internet using the fixed Elastic IP.
Cloudflare sees the Elastic IP — not the Lambda's internal address.*

VPC → NAT Gateways → **Create NAT gateway**

| Field | Value |
|-------|-------|
| Name | `nyscef-nat` |
| Subnet | `nyscef-public` ← the PUBLIC subnet (not private!) |
| Connectivity type | Public |
| Elastic IP allocation ID | Click **Use an Elastic IP** → select the one from Step 5 |

Click **Create NAT gateway** and **wait ~2 minutes** for the Status to show **Available**.

> **Why does the NAT Gateway go in the PUBLIC subnet?** It needs to be able to reach the
> internet directly (via the Internet Gateway), so it must live in a subnet that has internet
> access. The Lambda stays in the private subnet and routes its traffic to the NAT Gateway.

---

### Step 7 — Route the private subnet through the NAT Gateway

*Now we tell the Lambda's private subnet: "when you need to reach the internet, send traffic to
the NAT Gateway."*

VPC → Route Tables → **Create route table**
- Name: `nyscef-private-rt`
- VPC: `nyscef-vpc`
- Click **Create route table**

Select the new route table → **Routes tab → Edit routes → Add route:**
- Destination: `0.0.0.0/0`
- Target: NAT Gateway → `nyscef-nat`
- Click **Save changes**

Still on the same route table → **Subnet associations tab → Edit subnet associations:**
- Check `nyscef-private`
- Click **Save associations**

> After this step, the network path is fully wired:
> `Lambda → private subnet → NAT Gateway (public subnet) → Elastic IP → internet`

---

### Step 8 — Create a Security Group for the Lambda

*A Security Group is a firewall. We need to tell AWS "this Lambda is allowed to make outbound
connections" — which is actually the default, so this step mostly just creates a named group
we can attach to the Lambda.*

VPC → Security Groups → **Create security group**

| Field | Value |
|-------|-------|
| Security group name | `nyscef-lambda-sg` |
| Description | `nyscef-uploader Lambda outbound` |
| VPC | `nyscef-vpc` |
| Inbound rules | (none — Lambda doesn't receive incoming connections) |
| Outbound rules | All traffic, `0.0.0.0/0` (this should already be the default) |

Click **Create security group**.

> **Why no inbound rules?** Lambda is triggered by SQS (a queue push), not by incoming network
> connections. It only needs to make outbound connections: to NYSCEF, to the database, to
> Secrets Manager, etc.

---

### Step 9 — Attach the Lambda to the VPC

*This is the final wiring step. We tell the Lambda to live inside `nyscef-private` instead of
the default AWS public network.*

Lambda → Functions → `nyscef-uploader` → **Configuration tab → VPC → Edit**

| Field | Value |
|-------|-------|
| VPC | `nyscef-vpc` |
| Subnets | `nyscef-private` |
| Security groups | `nyscef-lambda-sg` |

Click **Save** and wait ~45 seconds for the change to apply.

> All Lambda egress now routes through the Elastic IP you recorded in Step 5. Every cold start,
> every warm start, every invocation — they all appear to the outside world as that one fixed IP.

> **Note on database access:** If the database (RDS or otherwise) is in a different VPC or
> requires a specific security group to be whitelisted, you may need to add the
> `nyscef-lambda-sg` to its inbound rules on port 3306. Check if uploads to the DB start
> failing after this change.

---

## Part 2 — Lambda Environment Variables

*Environment variables are settings passed into the Lambda at runtime — similar to a `.env`
file in local development. `CF_INJECT_COOKIE=true` tells the Lambda to read the stored
`cf_clearance` cookie from Secrets Manager and inject it into the browser before visiting
NYSCEF.*

Lambda → Functions → `nyscef-uploader` → **Configuration tab → Environment variables → Edit**

Click **Add environment variable:**

| Key | Value |
|-----|-------|
| `CF_INJECT_COOKIE` | `true` |

Click **Save**.

> This flag was always in the code but intentionally left disabled — it's only safe to use when
> all containers share a fixed IP, which is now the case.

---

## Part 3 — Clear the Stale Cookie in Secrets Manager

*AWS Secrets Manager is a secure vault for sensitive values (passwords, tokens, etc.). The
Lambda stores the `cf_clearance` cookie here so it persists across cold starts. Before we
enable cookie injection, we need to wipe any old cookie that was minted on a different IP —
injecting a wrong-IP cookie is actually worse than injecting nothing.*

Secrets Manager → Secrets → search for `nyscef/cf_clearance` → click it

**Retrieve secret value → Edit** (or the pencil icon next to the value)

Replace the current value with:
```json
{ "cf_clearance": "" }
```

Click **Save**.

> The Lambda will see an empty `cf_clearance` value and skip injection on the first run,
> arriving clean. After a successful login it will save the new (correct IP) cookie here
> automatically, and every subsequent cold start will inject it.

---

## Part 4 — Bootstrap the Cookie (First Run)

*We need to trigger one successful login from the new fixed IP to earn the `cf_clearance` cookie
for it. After that, every cold start can inject the stored cookie and skip the Cloudflare check.*

Lambda → Functions → `nyscef-uploader` → **Test tab**

If there's no test event yet, click **Create new test event.** Use any name. Set the payload to:
```json
{ "_selfTest": true }
```

Click **Test**.

Then open **CloudWatch Logs** to see what happened:
- AWS Console → CloudWatch → Log groups → `/aws/lambda/nyscef-uploader`
- Open the most recent log stream

**What you want to see (first run):**
```
cf_clearance is empty — arriving clean for this cold start
Logging into NYSCEF...
Login page response: status=503, url=...
Cloudflare 503 interstitial — waiting for it to auto-solve...
Successfully logged into NYSCEF
Persisted fresh cf_clearance to Secrets Manager    ← cookie saved!
```

> A **503** here is actually fine — it's Cloudflare's lighter "checking your browser"
> interstitial (the spinning wheel), which auto-solves itself in the browser within ~12 seconds.
> The code already handles this. You may also just get a direct 200 (login page loads clean) if
> the Elastic IP is already trusted.

**What you want to see (second cold start, once the cookie is stored):**
```
Injected cf_clearance cookie                       ← stored cookie injected
Logging into NYSCEF...
Login page response: status=200, url=https://iapps.courts.state.ny.us/nyscef/Login
Successfully logged into NYSCEF                    ← no challenge, clean login
```

**If the first run logs `CloudflareBlockError (status=403)`:**
The code automatically evicts the bad cookie from Secrets Manager (self-healing). Trigger the
test again — it will arrive clean. If 403s keep happening after 3–4 attempts, see the Fallback
section below.

---

## Part 5 — Verify a Cold Start Works

*Warm starts (reusing an already-running container) were always working. We need to prove that
a brand-new cold start also works with the injected cookie.*

Force a fresh cold start by making a trivial change to an environment variable (add a dummy one
like `_TEST=1`, save, then delete it and save again). This forces a new container on the next
invocation.

Then trigger another `_selfTest` invocation and confirm in CloudWatch:

- ✅ `Injected cf_clearance cookie` appears
- ✅ `Successfully logged into NYSCEF` follows
- ✅ No `CloudflareBlockError`

---

## Fallback — Residential Proxy (if Elastic IP still gets 403)

AWS Elastic IPs are still datacenter IPs — Cloudflare knows they come from Amazon's data
centers and may challenge them even when fresh. If 403s keep happening after the VPC setup,
the next step is routing the Lambda's browser traffic through a **residential proxy**.

**What's a residential proxy?** A service that routes your traffic through real home internet
connections (people who've opted into a network). Cloudflare scores residential IPs much lower
on its bot-suspicion scale because they look like regular users. With a "sticky session"
option, you're always assigned the same residential IP — so the `cf_clearance` cookie model
still works.

1. Sign up for a residential proxy service with sticky sessions:
   - [BrightData](https://brightdata.com) — most reliable, ~$100/mo for light usage
   - [Oxylabs](https://oxylabs.io) — similar tier
   - [SmartProxy](https://smartproxy.com) — cheaper, adequate for low volume

2. Get a sticky-session endpoint URL — it will look something like:
   ```
   http://username:password@gate.smartproxy.com:10001
   ```

3. Lambda → Functions → `nyscef-uploader` → **Configuration → Environment variables → Edit**
   - Add: `PROXY_URL` = `http://username:password@proxy.host:port`

The proxy code is already in `initBrowser.ts` — it activates automatically when `PROXY_URL` is
set. The VPC + cookie injection model stays intact; the proxy just provides a residential IP
instead of the datacenter EIP.

---

## Ongoing Maintenance

The `cf_clearance` cookie typically lasts about a year. If cold starts start failing again with
403 errors after a long quiet period, it usually means the cookie expired or Cloudflare
rotated its validation.

**What to do:**
1. Go to Secrets Manager → `nyscef/cf_clearance` → check if the value is non-empty
2. If it is non-empty (stale cookie), the self-healing code will auto-clear it on the next 403
   and re-bootstrap on the following attempt — you may not need to do anything
3. If 403s are persisting through multiple SQS retry cycles (check CloudWatch), force a clean
   bootstrap manually:
   - Set `nyscef/cf_clearance` to `{ "cf_clearance": "" }` in Secrets Manager
   - Trigger a `_selfTest` invocation — this will earn a fresh cookie for the fixed IP

**Cost reminder:** The NAT Gateway and Elastic IP cost roughly $45–50/month total. The Elastic
IP specifically costs ~$0.005/hour (~$3.60/month) while it's allocated. If the Lambda is ever
decommissioned, remember to release the Elastic IP to avoid ongoing charges.
