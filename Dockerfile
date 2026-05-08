FROM node:24-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack install --global pnpm@10

# ── Clone upstream and apply patches ──
FROM base AS source
ARG NODEONLY_REPO=https://github.com/mrbart3885/Risuai-NodeOnly.git
ARG NODEONLY_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${NODEONLY_REF} ${NODEONLY_REPO} .
COPY inject/proxy-inject.js public/
COPY patches/apply.cjs apply-llm-proxy-patch.cjs
RUN node apply-llm-proxy-patch.cjs

# ── Production dependencies ──
FROM base AS deps
COPY --from=source /app/package.json /app/pnpm-lock.yaml ./
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# ── Full build ──
FROM deps AS builder
COPY --from=source /app .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN pnpm build

# ── Runtime ──
FROM base AS runtime
ARG TARGETARCH
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH}" \
       -o /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=source /app/package.json /app/pnpm-lock.yaml ./
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 6001
CMD ["pnpm", "runserver"]
