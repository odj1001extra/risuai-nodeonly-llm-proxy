# RisuAI NodeOnly — LLM Proxy 배포 리포

RisuAI NodeOnly에 LLM proxy 패치를 적용하여 배포하는 self-contained 리포.
upstream 소스를 로컬에 두지 않고, Dockerfile이 빌드 시 clone → 패치 → 빌드까지 처리.

- **GitHub**: `odj1001extra/risuai-nodeonly-llm-proxy`
- **Upstream**: `mrbart3885/Risuai-NodeOnly` (public)

## 디렉토리 구조

```
├── Dockerfile              # upstream clone → 패치 → 빌드 → 런타임
├── docker-compose.yml      # risuai(6001) + llm-proxy(6100 internal)
├── llm-proxy/              # 서버사이드 응답 버퍼링 사이드카
│   ├── Dockerfile          #   node:20-slim, undici
│   ├── admin/              #   대시보드 HTML
│   └── src/                #   index.js, relay.js, store.js, ...
├── inject/
│   └── proxy-inject.js     # 클라이언트 fetch 가로채기 + SSE 재연결 (41KB)
├── patches/
│   └── apply.cjs           # 소스 패치 (Dockerfile에서 자동 실행)
└── custom-manifest/
    └── manifest.json       # PWA manifest 커스터마이징
```

## 배포 명령어

```bash
# 일반 배포 (빌드+교체 한 번에)
docker compose up -d --build

# 안전한 2단계 배포 (운영 권장: 빌드 성공 확인 후 교체)
docker compose build --no-cache --build-arg NODEONLY_REF=v1.5.0 risuai
docker compose up -d                       # 새 이미지로 컨테이너 교체 (~20초 다운타임)

docker compose logs -f                    # 로그 확인
docker compose ps                          # 상태 확인
```

`--no-cache`는 `NODEONLY_REF=main` 같은 floating ref를 쓸 때 필수 — 안 그러면 git clone 결과가 layer cache되어 옛 SHA로 빌드됨.

## Dockerfile 빌드 스테이지

```
base    → node:24-slim + pnpm@10 (메이저 핀, 자세한 이유는 주의사항)
source  → git clone upstream + COPY patches + apply.cjs 실행
deps    → production dependencies (better-sqlite3 네이티브 빌드 포함)
builder → full dependencies + vite build
runtime → cloudflared + prod deps + server/ + dist/
```

## 패치 대상 (upstream 소스 3개 파일)

| 파일 | 변경 | 이유 |
|------|------|------|
| `index.html` | `proxy-inject.js` 스크립트 주입 | 클라이언트 fetch 가로채기 활성화 |
| `src/ts/globalApi.svelte.ts` | `!throughProxy` 조건 제거 | `userScriptFetch`가 모든 LLM 요청 가로채도록 |
| `server/node/server.cjs` | compression skip + reverse proxy | `/llm-proxy/*` → sidecar 라우팅 |

`patches/apply.cjs`는 idempotent — 이미 적용된 부분은 `[OK]`, 새로 적용한 건 `[PATCH]`로 출력. 빌드 로그에 `[PATCH] 4` 또는 `[OK] 4`가 모두 떠야 정상.

## upstream 업데이트 워크플로우

```bash
# 1. upstream 신규 태그 확인
git ls-remote --tags https://github.com/mrbart3885/Risuai-NodeOnly.git | tail

# 2. 호환성 검증 — staging에 fresh clone + dry-run apply
STAGE=/tmp/nodeonly-<ver>-stage
rm -rf "$STAGE"
git clone --depth 1 --branch <ver> https://github.com/mrbart3885/Risuai-NodeOnly.git "$STAGE"
cp inject/proxy-inject.js "$STAGE/public/"
node patches/apply.cjs "$STAGE"           # 4단계 [PATCH] 모두 통과해야 안전

# 3. 통과하면 실제 빌드 + 배포 (위 "배포 명령어" 참고)
```

**패치가 깨졌을 때** (`apply.cjs`가 `[WARN] anchor not found`):
1. staging에서 깨진 단계 확인 → upstream diff로 anchor 변경 추적
2. `patches/apply.cjs`의 패턴/anchor를 새 코드에 맞게 수정
3. staging에서 재검증 → 통과 후 commit
4. 절대 upstream 소스를 직접 편집하지 않음. 진실의 원천은 `patches/apply.cjs`.

## 네트워크 / 접속 경로

```
[외부 HTTPS]  사용자 → Cloudflare Tunnel → cloudflared (컨테이너 내) → :6001
[로컬 HTTP]   브라우저 → http://localhost:56001 (Windows)
                       → netsh portproxy → WSL eth0:6001 → docker-proxy → 컨테이너:6001
```

- **HTTPS는 외부 도메인(Cloudflare Tunnel)으로만**. 로컬 :6001/:56001은 평문 HTTP. `https://localhost:56001`은 의도적으로 안 됨 (TLS 종단점 없음).
- localhost는 브라우저 secure context로 인정 → `crypto.subtle` 등 평문에서도 동작. PWA / Vertex AI 기능 검증 가능.
- Windows portproxy 매핑 확인:
  ```powershell
  powershell.exe -NoProfile -Command "netsh interface portproxy show all"
  ```

## LLM Proxy 동작 원리

```
Browser → proxy-inject.js (window.userScriptFetch)
  │ POST /llm-proxy/request {url, headers, body}
  ▼
NodeOnly Express (reverse proxy, express.json 전에 위치)
  │ raw body pipe → llm-proxy:6100
  ▼
llm-proxy sidecar
  │ HTTP/2 relay → LLM API (Vertex AI, OpenAI, etc.)
  │ 응답 chunk를 메모리에 버퍼링 (store.js)
  ▼
모바일 백그라운드 → 연결 끊김 → 버퍼 유지
  ▼
포그라운드 복귀 → visibilitychange → SSE 재연결
  GET /llm-proxy/stream/:id?offset=N → 누락분 전송
```

## llm-proxy 주요 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| POST | `/request` | LLM 요청 시작, requestId 반환 |
| GET | `/stream/:id` | SSE (offset 재연결 지원) |
| GET | `/status/:id` | 상태 조회 |
| POST | `/cancel/:id` | 취소 |
| GET | `/admin` | 대시보드 UI |
| GET | `/requests` | 진행 중 목록 |
| GET | `/requests/history` | 완료 기록 |
| GET | `/health` | 헬스체크 |
| GET | `/logs` | 서버 로그 |
| GET | `/metrics/cost` | 비용 통계 |

## llm-proxy 환경변수

| Variable | Default | 설명 |
|----------|---------|------|
| `BUFFER_TTL_MINUTES` | `30` | 버퍼 만료 시간 |
| `MAX_CONCURRENT_REQUESTS` | `200` | 최대 동시 요청 |
| `MAX_BUFFER_SIZE_MB` | `512` | 최대 버퍼 메모리 |
| `RELAY_TIMEOUT_SECONDS` | `300` | 릴레이 타임아웃 |
| `LOG_LEVEL` | `info` | 로그 레벨 |

## Docker 볼륨

- `risuai-save` → `/app/save` (SQLite DB + 에셋, 영속)
- `custom-manifest/manifest.json` → `/app/dist/manifest.json` (read-only)

## 주의사항

- `express.json()` 전에 `/llm-proxy` reverse proxy를 배치해야 raw body pipe 가능
- `/llm-proxy` 경로를 compression skip에 추가해야 SSE 스트리밍이 버퍼링되지 않음
- HTTPS 필수 (Cloudflare Tunnel) — Vertex AI JWT 서명에 `crypto.subtle` 필요
- `patches/apply.cjs`는 idempotent — 이미 적용된 패치는 건너뜀
- **pnpm은 `pnpm@10`으로 핀**되어 있음. `pnpm@latest`로 바꾸지 말 것 — pnpm 11에서 `--prod` + `onlyBuiltDependencies` 조합이 깨져서 `better-sqlite3`/`sharp` 등 native binding 빌드가 `[ERR_PNPM_IGNORED_BUILDS]`로 실패함.
- WSL 환경에서 Docker Desktop integration과 native dockerd가 한 distro에 같이 있으면 데몬 이중화로 메타데이터 탈동기화 사고 발생. 이 distro(FedoraLinux-42)에는 **native dockerd만** 사용.

## 관련 프로젝트

- **myrisuai** (`~/workspace/projects/charxEditor/myrisuai/`) — llm-proxy 원본 구현
