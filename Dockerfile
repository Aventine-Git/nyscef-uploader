# Build context must be the lambdas/ root directory (parent of nyscef-uploader/).
# Run from lambdas/:  docker build -f nyscef-uploader/Dockerfile -t nyscef-uploader .
# Or use docker-compose from the nyscef-uploader/ directory.

FROM node:22-bookworm-slim

WORKDIR /app

# ── Build _SHARED ──────────────────────────────────────────────────────────────
# Install all deps first (TypeScript needed to build), then build, then prune to
# production only. This keeps the TypeScript compiler out of the final runtime.
COPY _SHARED/package*.json ./_SHARED/
RUN cd _SHARED && npm ci

COPY _SHARED/src ./_SHARED/src
COPY _SHARED/tsconfig.json ./_SHARED/tsconfig.json
COPY _SHARED/scripts ./_SHARED/scripts

RUN cd _SHARED && npm run build && npm prune --production

# ── Install nyscef-uploader deps ───────────────────────────────────────────────
COPY nyscef-uploader/package*.json ./nyscef-uploader/
RUN cd nyscef-uploader && npm ci

# Install Playwright Chromium and all its OS dependencies.
# Doing this BEFORE copying src means the ~1GB browser layer is only rebuilt when
# the playwright version changes, not on every code edit.
RUN cd nyscef-uploader && npx playwright install --with-deps chromium

# ── Build nyscef-uploader TypeScript ──────────────────────────────────────────
COPY nyscef-uploader/src ./nyscef-uploader/src
COPY nyscef-uploader/tsconfig.json ./nyscef-uploader/tsconfig.json

RUN cd nyscef-uploader && npx tsc && node ../_SHARED/scripts/fix-imports.mjs

# Prune dev dependencies (keeps playwright-core, which is a production dep)
RUN cd nyscef-uploader && npm prune --production

# ── Runtime ───────────────────────────────────────────────────────────────────
WORKDIR /app/nyscef-uploader

CMD ["node", "dist/worker.js"]
