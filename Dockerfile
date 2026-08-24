FROM node:24-slim AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack install --global pnpm@10

# ── Clone upstream and apply patches ──
FROM base AS source
# upstream이 PocketRisu/PocketRisu 로 이전됨 (v1.10.0부터). 구 리포
# mrbart3885/Risuai-NodeOnly 는 v1.9.0 에서 태그가 멈춰 더 이상 갱신되지 않는다.
ARG NODEONLY_REPO=https://github.com/PocketRisu/PocketRisu.git
ARG NODEONLY_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${NODEONLY_REF} ${NODEONLY_REPO} .
# llm-proxy 패치는 2026-08-22 부로 기본 비활성 (사이드카 은퇴).
# upstream v1.9.0+ 의 서버사이드 job(/api/model-jobs)이 같은 역할을 더 안전하게
# 수행하고, 우리 패치는 오히려 응답 유실 경로를 만들고 있었다.
# 배경·근거·롤백: docs/2026-08-22-llm-proxy-retirement.md
# 되살리려면: --build-arg APPLY_LLM_PROXY_PATCH=true
ARG APPLY_LLM_PROXY_PATCH=false
COPY inject/proxy-inject.js public/
COPY patches/apply.cjs apply-llm-proxy-patch.cjs
RUN if [ "$APPLY_LLM_PROXY_PATCH" = "true" ]; then \
      node apply-llm-proxy-patch.cjs; \
    else \
      echo "[SKIP] llm-proxy patch not applied (retired 2026-08-22)"; \
    fi

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
