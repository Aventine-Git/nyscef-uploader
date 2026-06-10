FROM node:22-bookworm-slim

WORKDIR /app

# ── Install dependencies ───────────────────────────────────────────────────────
# Copy package files first so this layer is only rebuilt when dependencies change,
# not on every source code edit.
COPY package*.json ./
RUN npm ci

# Install Playwright Chromium and all its OS dependencies.
# Doing this BEFORE copying src means the ~300MB browser layer is cached and only
# rebuilds when the playwright version changes.
RUN npx playwright install --with-deps chromium

# ── Build TypeScript ──────────────────────────────────────────────────────────
COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# Prune dev dependencies — removes TypeScript compiler etc. from the final image
RUN npm prune --production

# ── Runtime ───────────────────────────────────────────────────────────────────
CMD ["node", "dist/worker.js"]
