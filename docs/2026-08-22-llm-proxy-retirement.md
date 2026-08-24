# llm-proxy 사이드카 은퇴 (2026-08-22)

PocketRisu v1.10.0 업그레이드와 함께 `llm-proxy` 사이드카 및 관련 소스 패치를
**적용 중단**한다. 소스는 리포에 남기되 빌드/런타임에서 제외한다.

## 요약

| | 은퇴 전 | 은퇴 후 |
|---|---|---|
| 채팅 생성 전송 경로 | `POST /llm-proxy/request` (브라우저 → 사이드카) | `POST /api/model-jobs` (upstream 서버사이드 job) |
| 응답 소유자 | 브라우저 JS 프로미스 | 서버 (저널 기록, 재접속 복구) |
| 적용 패치 | 4개 (`patches/apply.cjs`) | 0개 |
| 컨테이너 | `risuai` + `llm-proxy` | `risuai` 단독 |

## 왜 은퇴하는가

### 1. upstream이 같은 기능을 더 낫게 구현했다

사이드카의 존재 이유는 "브라우저가 이탈해도 서버가 응답을 계속 받아 버퍼링"이었다.
PocketRisu v1.9.0의 `feat: durable server-side model requests with resumable sends`가
이걸 네이티브로 구현했다 (`server/node/model-jobs.cjs`, `src/ts/process/request/jobFetch.ts`).

`jobFetch.ts` 주석이 설계를 그대로 설명한다:

> 브라우저가 provider를 직접 fetch하는 대신 서버 job을 만들고(`POST /api/model-jobs`),
> job의 저널 스트림으로 원본 바이트를 되읽는다(`GET /api/model-jobs/:id/stream`).
> **이 클라이언트가 끊겨도 서버는 upstream 소비를 계속하므로**, 연결이 끊겨도
> 생성이 죽지 않는다 — 저널에서 복구된다.

`nodeOnlyServerSideRequests` 는 DB 로드 시 `??= true` 로 기본 활성이다
(`src/ts/storage/database.svelte.ts`).

### 2. 우리 패치가 오히려 응답 유실을 만들고 있었다

패치 2번(`globalApi.svelte.ts` 의 `!throughProxy` 조건 제거)은 **모든 LLM 요청을**
`window.userScriptFetch`(= `inject/proxy-inject.js`)로 강제한다. v1.8.1 클라이언트에는
job 시스템이 없었으므로, 6001은 **서버가 소유하는 내구성 전송을 브라우저가 소유하는
취약한 전송으로 바꿔치기한 상태**였다.

`inject/proxy-inject.js` 의 실패 경로:

```js
function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {   // 10회
        cleanup();
        settledReject(new Error('Max reconnection attempts exceeded'));
        return;
    }
    ...
```

SSE 재연결 10회가 소진되면 **응답은 버려진다.** 사이드카 버퍼에 데이터가 남아 있어도
채팅에 꽂아줄 주체가 없다. 반면 job 경로는 서버가 결과를 들고 있어 재접속 시 복구된다.

여기에 인프라 문제가 겹쳤다 — `tailscale serve` 가 `localhost`(→ Windows에서 `::1`
우선)로 프록시하는데 `netsh portproxy` 는 IPv4(`0.0.0.0`)만 수신해서, 유휴 후 첫
동시 요청 묶음에서 일부가 **502**로 죽었다. 장시간 유지되는 우리 SSE 스트림이 정확히
그 희생양이었다. (별도 수정: serve 대상을 `127.0.0.1` 로 고정 — 아래 "관련 조치" 참고)

### 3. 실측: 사이드카는 이미 우회되고 있다

v1.10.0 클라이언트로 6001에서 메시지 전송 시 관측된 네트워크:

```
POST /api/model-jobs                → 200 (48B)
GET  /api/model-jobs/<id>/stream    → 200 (7,569B)
GET  /api/model-jobs/<id>           → 200 (425B)
POST /api/model-jobs/<id>/claim     → 200
```

`/llm-proxy/*` 호출은 **채팅 생성에 단 한 건도 없었다.** 사이드카 로그에는 Gemini
모델 목록 조회 같은 부수 요청만 남았다. 즉 핵심 기능은 이미 upstream에 흡수됐다.

## 포기하는 것

| 기능 | 대체 |
|---|---|
| 관리자 대시보드 (`/llm-proxy/admin`) | PocketRisu `[시스템] > 리퀘스트 로그` 탭 (v1.9.0 추가) |
| 비용 통계 (`/metrics/cost`) | `[시스템] > 사용량 통계` 탭 (v1.9.0 추가) |
| 30분 버퍼 TTL / 수동 재연결 튜닝 | job 저널 (기본 보존 7일, `MODEL_JOB_MAX_RETAINED_AGE_MS`) |

과거 기록은 `~/backups/pocketrisu/llm-proxy-final/` 에 보존:
`cost-data.json`, `request-log.json`

## 변경 내역

### `Dockerfile`
- `ARG APPLY_LLM_PROXY_PATCH` 기본값을 `true` → `false` 로 변경.
  `--build-arg APPLY_LLM_PROXY_PATCH=true` 로 언제든 되살릴 수 있다.
- `ARG NODEONLY_REPO` 를 `PocketRisu/PocketRisu` 로 변경 (구 리포
  `mrbart3885/Risuai-NodeOnly` 는 v1.9.0 에서 태그가 멈춤).

### `docker-compose.yml`
- `llm-proxy` 서비스와 `risuai` 의 `depends_on` 을 **주석 처리**(삭제 아님).
  주석 블록에 은퇴 사유와 되살리는 방법을 함께 적어뒀다.
- 진단용으로 켰던 `LOG_LEVEL=debug` 도 함께 주석 안으로 들어감.
- `risuai-save` 볼륨 정의는 그대로 유지 — 데이터는 손대지 않는다.

### 남겨두는 것 (삭제하지 않음)
- `llm-proxy/` — 사이드카 소스 전체
- `inject/proxy-inject.js` — 클라이언트 가로채기 스크립트
- `patches/apply.cjs` — 소스 패치 (v1.10.0 에서도 4/4 정상 적용 확인됨)

되살릴 필요가 생기면 아래 "롤백" 참고.

## 롤백

```bash
# 1. docker-compose.yml 의 llm-proxy 블록과 risuai 의 depends_on 주석 해제
#    (파일 안에 주석으로 표시해둠)

# 2. 패치 켜고 재빌드
docker compose build --no-cache \
  --build-arg NODEONLY_REF=v1.10.0 \
  --build-arg APPLY_LLM_PROXY_PATCH=true risuai
docker compose up -d
```

패치 호환성은 빌드 로그의 `=== 결과: 4개 패치 적용됨 ===` 으로 확인한다.

데이터(`risuai-nodeonly_risuai-save` 볼륨)는 이 작업에서 건드리지 않는다.
업그레이드 직전 백업: `~/backups/pocketrisu/6001-save-pre-v1.10.0-20260822.tar.gz`

## 관련 조치 (별건)

### tailscale serve IPv4 고정
`netsh portproxy` 가 IPv4 만 수신하는데 `tailscale serve` 가 `localhost` 로
프록시해서 유휴 후 콜드 버스트에서 502 가 발생했다. 전 포트를 `127.0.0.1` 로 고정.

```
tailscale serve --bg --https=<포트> http://127.0.0.1:<포트>
```

수정 전 콜드 10동시: 56001 `2/10 실패`, 56002 `1~3/10 실패`
수정 후: 56001/56002/8190 각 20동시 콜드 **전부 200**

### llm-proxy abort race 수정 (은퇴로 무의미해졌으나 이력 보존)
`llm-proxy/src/relay.js` 의 `h2fetch` 가 업스트림 **헤더 도착 시점에** abort 리스너를
해제해서, 본문 수신 중(60~150초) 취소가 no-op 이 되던 버그. 취소된 요청이 뒤늦게
완료되어 아무도 안 듣는 상태로 버려졌다. 본문 종료까지 리스너를 유지하도록 수정하고
`store.js` 에 terminal-status 가드를 추가했다. 회귀 테스트 2건 통과.
