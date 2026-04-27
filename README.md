# RisuAI NodeOnly — LLM Proxy Patch

모바일 브라우저에서 탭 전환(백그라운드) 시 LLM 응답이 유실되는 문제를 해결합니다.

## 원리

모바일 OS는 백그라운드 탭의 네트워크 연결을 강제 종료합니다. 이 패치는 서버 측에서 LLM 응답을 버퍼링하고, 브라우저가 포그라운드로 복귀하면 SSE(Server-Sent Events)로 재연결하여 누락된 응답을 전달합니다.

```
Browser ──► NodeOnly (Express reverse proxy) ──► llm-proxy (sidecar)
                /llm-proxy/*                       서버사이드 응답 버퍼링
                                                   SSE offset 기반 재연결
```

## 구성 파일

| 파일 | 설명 |
|------|------|
| `apply-llm-proxy-patch.cjs` | 패치 스크립트 (idempotent) |
| `proxy-inject.js` | 클라이언트 측 fetch 가로채기 + SSE 재연결 |
| `llm-proxy/` | 서버사이드 응답 버퍼링 Docker 사이드카 |

## 패치 대상 (NodeOnly 소스)

| 파일 | 변경 내용 |
|------|-----------|
| `index.html` | proxy-inject.js 로드 스크립트 주입 |
| `src/ts/globalApi.svelte.ts` | `!throughProxy` 조건 제거 → `userScriptFetch` 활성화 |
| `server/node/server.cjs` | `/llm-proxy` compression skip + reverse proxy route 추가 |
| `docker-compose.yml` | llm-proxy 서비스 추가 |

## 설치

```bash
# 1. NodeOnly 디렉토리에 파일 복사
cp proxy-inject.js <NODEONLY_DIR>/public/
cp -r llm-proxy <NODEONLY_DIR>/
cp apply-llm-proxy-patch.cjs <NODEONLY_DIR>/

# 2. 패치 적용 + 빌드 + 배포
cd <NODEONLY_DIR>
node apply-llm-proxy-patch.cjs --deploy
```

## NodeOnly 업데이트 후 재적용

```bash
cd <NODEONLY_DIR>
# upstream 소스 업데이트 후
node apply-llm-proxy-patch.cjs --deploy
```

이미 적용된 패치는 건너뛰고, 필요한 것만 적용합니다.

## 패치 확인 (dry-run)

```bash
node apply-llm-proxy-patch.cjs
```

`--deploy` 없이 실행하면 패치 상태만 확인하고 빌드/배포하지 않습니다.

## docker-compose.yml 예시

```yaml
services:
  risuai:
    image: ghcr.io/mrbart3885/risuai-nodeonly:latest
    ports:
      - 6001:6001
    volumes:
      - risuai-save:/app/save
      - ./dist:/app/dist:ro
      - ./server:/app/server:ro
    depends_on:
      - llm-proxy

  llm-proxy:
    build: ./llm-proxy
    restart: always
```

## 요구사항

- Node.js 20+
- pnpm
- Docker / Docker Compose
- HTTPS 환경 (Cloudflare Tunnel 등) — Vertex AI JWT 서명에 `crypto.subtle` 필요
