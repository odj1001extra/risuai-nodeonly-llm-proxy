# RisuAI NodeOnly — LLM Proxy

모바일 브라우저 백그라운드 탭 전환 시 LLM 응답 유실을 방지하는 패치 + 배포 리포.

## 구조

```
├── Dockerfile              # upstream clone → 패치 → 빌드 → 런타임 (all-in-one)
├── docker-compose.yml      # risuai + llm-proxy 서비스
├── llm-proxy/              # 서버사이드 응답 버퍼링 사이드카
├── inject/
│   └── proxy-inject.js     # 클라이언트 fetch 가로채기 + SSE 재연결
├── patches/
│   └── apply.cjs           # 소스 패치 스크립트 (Dockerfile에서 자동 실행)
└── custom-manifest/
    └── manifest.json       # PWA manifest 커스터마이징
```

## 배포

```bash
docker compose up -d --build
```

Dockerfile이 자동으로:
1. upstream 소스 clone
2. 패치 적용 (proxy-inject.js 복사, 소스 수정)
3. 프론트엔드 빌드
4. 런타임 이미지 생성

## upstream 업데이트

Dockerfile의 `NODEONLY_REF`를 변경하고 재빌드:

```bash
# docker-compose.yml에서 build args 수정 또는:
docker compose build --build-arg NODEONLY_REF=v1.4.0 risuai
docker compose up -d
```

## 원리

```
Browser (proxy-inject.js)
  │  window.userScriptFetch → /llm-proxy/request
  ▼
NodeOnly Express (reverse proxy)
  │  /llm-proxy/* → llm-proxy:6100
  ▼
llm-proxy sidecar
  │  HTTP/2 relay → LLM API
  │  응답 chunk 서버사이드 버퍼링
  ▼
Browser 포그라운드 복귀
  GET /llm-proxy/stream/:id?offset=N
  └─ 누락분부터 SSE 재전송
```

## 패치 대상 (upstream 소스 4개 파일)

| 파일 | 변경 |
|------|------|
| `index.html` | `proxy-inject.js` 로드 스크립트 주입 |
| `src/ts/globalApi.svelte.ts` | `!throughProxy` 조건 제거 |
| `server/node/server.cjs` | compression skip + reverse proxy route |

## 관리 포인트

| URL | 설명 |
|-----|------|
| `:6001/llm-proxy/admin` | 대시보드 (요청 목록, 로그, 비용) |
| `:6001/llm-proxy/health` | 헬스체크 |

## 요구사항

- Docker / Docker Compose
- HTTPS 환경 (Cloudflare Tunnel 등) — `crypto.subtle` 필요
