# ── Stage 1: Build server ─────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# better-sqlite3 can compile when a prebuilt binary is unavailable.
RUN apk add --no-cache --virtual .native-build-deps python3 make g++ && \
    npm ci && \
    apk del .native-build-deps

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Build web-next dashboard ─────────────────────
FROM node:22-alpine AS web-builder

WORKDIR /app/web-next

COPY web-next/package.json web-next/package-lock.json ./
RUN npm ci

COPY web-next/ ./

ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}
RUN npm run build

# ── Stage 3: Runtime ──────────────────────────────────────
FROM node:22-alpine

RUN addgroup -g 1001 -S hxa && \
    adduser -S hxa -u 1001 -G hxa

WORKDIR /app

COPY package.json package-lock.json ./
RUN apk add --no-cache --virtual .native-build-deps python3 make g++ && \
    npm ci --omit=dev && \
    npm cache clean --force && \
    apk del .native-build-deps

COPY --from=builder /app/dist ./dist
COPY --from=web-builder /app/web-next/out ./web-next/out
COPY scripts/task-runner.mjs scripts/demo-tasks.mjs ./scripts/
COPY scripts/task-runner/ ./scripts/task-runner/

# Data volume (writable by hxa user)
RUN mkdir -p /app/data && chown hxa:hxa /app/data
VOLUME /app/data

ENV HXA_CONNECT_PORT=4800
ENV HXA_CONNECT_DATA_DIR=/app/data

EXPOSE 4800

USER hxa

CMD ["node", "dist/index.js"]
