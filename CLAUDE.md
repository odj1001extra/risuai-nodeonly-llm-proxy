# PocketRisu 배포 리포 (구 RisuAI NodeOnly — LLM Proxy)

PocketRisu를 빌드해서 배포하는 self-contained 리포.
upstream 소스를 로컬에 두지 않고, Dockerfile이 빌드 시 clone → 빌드까지 처리.

- **GitHub**: `odj1001extra/risuai-nodeonly-llm-proxy`
- **Upstream**: `PocketRisu/PocketRisu` (public)
  구 리포 `mrbart3885/Risuai-NodeOnly` 는 v1.9.0 에서 태그가 멈춤 — 참조하지 말 것.

> **⚠️ llm-proxy 사이드카는 2026-08-22 부로 은퇴했다.**
> upstream v1.9.0+ 의 서버사이드 job(`/api/model-jobs`)이 같은 역할을 더 안전하게
> 수행한다. 우리 패치는 오히려 응답 유실 경로를 만들고 있었다.
> 배경·근거·롤백: [`docs/2026-08-22-llm-proxy-retirement.md`](docs/2026-08-22-llm-proxy-retirement.md)
>
> 현재 빌드는 **순정(patch 미적용)** 이며, `llm-proxy/` · `inject/` · `patches/` 는
> 롤백용으로 보존만 되어 있고 빌드/런타임에 관여하지 않는다.

## 디렉토리 구조

```
├── Dockerfile              # upstream clone → 빌드 → 런타임 (패치는 기본 skip)
├── docker-compose.yml      # risuai(6001) 단독 — llm-proxy 는 주석 처리됨
├── docs/                   # 결정 기록
│   └── 2026-08-22-llm-proxy-retirement.md
├── custom-manifest/
│   └── manifest.json       # PWA manifest 커스터마이징 (사용 중)
│
│   ── 아래는 은퇴, 롤백용 보존 ──
├── llm-proxy/              # 사이드카 소스 (node:20-slim, undici)
├── inject/proxy-inject.js  # 클라이언트 fetch 가로채기 + SSE 재연결
└── patches/apply.cjs       # 소스 패치 (APPLY_LLM_PROXY_PATCH=true 일 때만 실행)
```

## 배포 명령어

```bash
# 일반 배포 (빌드+교체 한 번에)
docker compose up -d --build

# 안전한 2단계 배포 (운영 권장: 빌드 성공 확인 후 교체)
docker compose build --no-cache --build-arg NODEONLY_REF=v1.10.0 risuai
docker compose up -d                       # 새 이미지로 컨테이너 교체 (~20초 다운타임)

docker compose logs -f                    # 로그 확인
docker compose ps                          # 상태 확인
```

`--no-cache`는 `NODEONLY_REF=main` 같은 floating ref를 쓸 때 필수 — 안 그러면 git clone 결과가 layer cache되어 옛 SHA로 빌드됨.

## Dockerfile 빌드 스테이지

```
base    → node:24-slim + pnpm@10 (메이저 핀, 자세한 이유는 주의사항)
source  → git clone upstream (APPLY_LLM_PROXY_PATCH=true 일 때만 apply.cjs 실행)
deps    → production dependencies (better-sqlite3 네이티브 빌드 포함)
builder → full dependencies + vite build
runtime → cloudflared + prod deps + server/ + dist/
```

순정 빌드에서는 `source` 스테이지에 `[SKIP] llm-proxy patch not applied` 가 찍힌다.

## 패치 (은퇴 — 롤백 시에만 해당)

`APPLY_LLM_PROXY_PATCH=true` 로 빌드할 때만 적용된다. upstream 소스 3개 파일:

| 파일 | 변경 | 이유 |
|------|------|------|
| `index.html` | `proxy-inject.js` 스크립트 주입 | 클라이언트 fetch 가로채기 활성화 |
| `src/ts/globalApi.svelte.ts` | `!throughProxy` 조건 제거 | `userScriptFetch`가 모든 LLM 요청 가로채도록 |
| `server/node/server.cjs` | compression skip + reverse proxy | `/llm-proxy/*` → sidecar 라우팅 |

`patches/apply.cjs`는 idempotent — 이미 적용된 부분은 `[OK]`, 새로 적용한 건 `[PATCH]`로 출력. 활성화해 빌드하면 `=== 결과: 4개 패치 적용됨 ===` 이 떠야 정상. (v1.10.0 에서도 4/4 정상 적용 확인됨)

## upstream 업데이트 워크플로우

```bash
# 1. upstream 신규 태그 확인
git ls-remote --tags https://github.com/PocketRisu/PocketRisu.git | tail

# 2. 데이터 백업 (필수 — 볼륨 1.7GB, 대체 불가)
docker compose stop risuai
docker run --rm -v risuai-nodeonly_risuai-save:/src:ro -v ~/backups/pocketrisu:/dst \
  alpine tar czf /dst/6001-save-pre-<ver>-$(date +%Y%m%d).tar.gz -C /src .

# 3. 빌드 + 배포 (아래 "배포 명령어")
# 4. 업그레이드 후 데이터 무결성 확인 — 키/에셋 개수가 전후 동일해야 정상
docker compose exec -T risuai node -e "
const D=require('better-sqlite3');const db=new D('/app/save/risuai.db',{readonly:true});
const r=db.prepare('SELECT key FROM kv').all();const g={};
r.forEach(x=>{const p=String(x.key).split('/')[0];g[p]=(g[p]||0)+1;});
console.log('keys:',r.length,JSON.stringify(g));"
```

**클라이언트는 PWA 캐시를 탄다.** 서버만 새 버전이고 브라우저는 옛 번들을 쓰는 상황이
실제로 발생했다(서버 1.10.0 / UI 1.8.1). 업그레이드 후 UI 좌측 하단 버전이 안 바뀌면
PWA 재시작 → 그래도 안 되면 사이트 데이터 삭제. **버그 수정이 클라이언트 코드에
있으면 캐시를 비우기 전까지 적용되지 않는다.**

**패치를 되살릴 경우의 호환성 검증** (`APPLY_LLM_PROXY_PATCH=true` 사용 시):
```bash
STAGE=/tmp/nodeonly-<ver>-stage && rm -rf "$STAGE"
git clone --depth 1 --branch <ver> https://github.com/PocketRisu/PocketRisu.git "$STAGE"
cp inject/proxy-inject.js "$STAGE/public/"
node patches/apply.cjs "$STAGE"           # 4단계 모두 통과해야 안전
```
`[WARN] anchor not found` 가 뜨면 upstream diff로 anchor 변경을 추적해
`patches/apply.cjs` 를 고친다. 절대 upstream 소스를 직접 편집하지 않는다.

## 네트워크 / 접속 경로

```
[외부 HTTPS]  사용자 → Cloudflare Tunnel → cloudflared (컨테이너 내) → :6001
[Tailscale]   폰/태블릿 → https://<host>.ts.net:56001
                       → tailscale serve (TLS 종단) → 127.0.0.1:56001 (Windows)
                       → netsh portproxy → WSL eth0:6001 → docker-proxy → 컨테이너:6001
[로컬 HTTP]   브라우저 → http://localhost:56001 (Windows) → 위와 동일
```

- **HTTPS는 Cloudflare Tunnel 또는 Tailscale로만**. 로컬 :6001/:56001은 평문 HTTP.
- localhost는 브라우저 secure context로 인정 → `crypto.subtle` 등 평문에서도 동작.
- **⚠️ `tailscale serve` 대상은 반드시 `127.0.0.1` 로 쓸 것.** `localhost` 로 쓰면
  Windows에서 `::1`(IPv6)을 먼저 시도하는데 `netsh portproxy` 는 IPv4(`0.0.0.0`)만
  수신해서, 유휴 후 첫 동시 요청 묶음의 일부가 **502**로 죽는다. 이미지가 절반만
  로드되는 증상으로 나타난다. (2026-08-22 전 포트 수정 완료)
  ```powershell
  # 설정 (포트별)
  tailscale serve --bg --https=<포트> http://127.0.0.1:<포트>
  # 확인
  tailscale serve status
  netsh interface portproxy show all
  ```
- 포트 매핑 정본: `/mnt/c/_scripts/v3/ports.config` (Windows 스크립트가 읽어 등록).
  단 tailscale serve 등록은 별도이며 자동화되어 있지 않다.

## LLM 요청 경로 (v1.9.0+ 서버사이드 job)

```
Browser (jobFetch.ts)
  │ POST /api/model-jobs  {targetUrl, headers, body, chatId, generationId}
  ▼
PocketRisu 서버 (model-jobs.cjs) — RECORDER
  │ upstream HTTP 요청 → 응답 바이트를 append-only 저널에 기록
  │ ★ 클라이언트가 끊겨도 서버는 계속 소비한다
  ▼
Browser  GET /api/model-jobs/:id/stream   (byte 0 부터 replay + live tail)
  │ 끊기면 재연결하며 이미 받은 만큼 skip
  ▼
완료 시  POST /api/model-jobs/:id/claim   (중복 삽입 방지)
```

- 토글: `nodeOnlyServerSideRequests` (DB 로드 시 `??= true`, 즉 기본 켜짐)
- 저널 보존: 기본 7일 (`MODEL_JOB_MAX_RETAINED_AGE_MS`)
- 진행/기록 확인: 앱 내 `[시스템] > 리퀘스트 로그` · `사용량 통계` 탭

## Docker 볼륨

- `risuai-save` → `/app/save` (SQLite DB + 에셋, 영속) — **업그레이드 전 반드시 백업**
- `custom-manifest/manifest.json` → `/app/dist/manifest.json` (read-only)
- 백업 위치: `~/backups/pocketrisu/`

## 주의사항

- HTTPS 필수 (Cloudflare Tunnel / Tailscale) — Vertex AI JWT 서명에 `crypto.subtle` 필요
- **클라이언트 코드 수정은 PWA 캐시를 비워야 적용된다** (서버 버전과 UI 버전이 다를 수 있음)
- **pnpm은 `pnpm@10`으로 핀**되어 있음. `pnpm@latest`로 바꾸지 말 것 — pnpm 11에서 `--prod` + `onlyBuiltDependencies` 조합이 깨져서 `better-sqlite3`/`sharp` 등 native binding 빌드가 `[ERR_PNPM_IGNORED_BUILDS]`로 실패함.
- WSL 환경에서 Docker Desktop integration과 native dockerd가 한 distro에 같이 있으면 데몬 이중화로 메타데이터 탈동기화 사고 발생. 이 distro(FedoraLinux-42)에는 **native dockerd만** 사용.

## 관련 프로젝트

- **pocketRisu** (`~/workspace/projects/pocketRisu/`) — 순정 PocketRisu 공식 이미지
  인스턴스(6002, 별도 볼륨 `pocketrisu-save`). 대조군/실험용.
- **myrisuai** (`~/workspace/projects/charxEditor/myrisuai/`) — llm-proxy 원본 구현 (은퇴)
