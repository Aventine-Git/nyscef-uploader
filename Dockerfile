FROM node:22-bookworm-slim

WORKDIR /app

# ── Install dependencies ───────────────────────────────────────────────────────
# Copy package files first so this layer is only rebuilt when dependencies change,
# not on every source code edit.
COPY package*.json ./
RUN npm ci

# Google Chrome stable, not Playwright's Chromium, which Cloudflare challenges (CLOUDFLARE-RUNBOOK.md).
# Chrome's version is whatever was current when this layer built, and the layer is cached until the
# lines above it change — refreshing Chrome means rebuilding without cache.
RUN npx playwright install --with-deps chrome

# ── Build TypeScript ──────────────────────────────────────────────────────────
COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# Prune dev dependencies — removes TypeScript compiler etc. from the final image
RUN npm prune --production

# ── Runtime ───────────────────────────────────────────────────────────────────
CMD ["node", "dist/worker.js"]
