# HypaMemory 벡터 캐시 조회 최적화 (2026-08-24)

- 대상: `patches/hypa-parallel.cjs` (`APPLY_HYPA_PARALLEL_PATCH`, 기본 **true**)
- 결과: tailscale 경유 **431초 → 0.31초**

## 증상

응답은 8초 만에 도착하는데 **메시지가 채팅에 붙기까지 1분 이상** 걸리고 그동안
스피너만 돈다. 6001에서만 발생, 6002는 정상.

## 원인

`HypaProcesser.addText()` (`src/ts/process/memory/hypamemory.ts:191`)가
청크마다 `await getPersistedHypaVector(...)` 로 **HTTP 1건씩 순차** 조회한다.

```js
for(let i=0;i<texts.length;i++){
    const itm = await getPersistedHypaVector(texts[i] + '|' + this.model + suffix)
```

이 대화에서는 **1,482건**. 로컬은 건당 3ms라 티가 안 나지만, 폰(tailscale DERP
릴레이)에서는 왕복이 커져 수 분이 된다.

### 왜 6001에서만

| | 6001 | 6002 |
|---|---|---|
| `cache/hypa-vector` 키 | **2,402개 (18.7MB)** | **0개** |

6002는 벡터가 아예 없어 원리적으로 발생할 수 없다. 코드는 양쪽 동일
(`server/` 해시 일치, 핵심 번들 해시 일치) — **데이터 차이였다.**

### 판정 근거

- 증상 중 컨테이너 수신 패킷 2초에 0개 → 서버·세션 무관, 클라이언트 대기
- 메인스레드 블로킹 총 411ms → CPU 아님, **순수 왕복 대기**
- 읽은 키 1,482건 **전부** `cache/hypa-vector/<hash>.json`

## 수정

3단계로 적용한다. 모두 **읽기 전용 조회**라 의미 변화가 없다.

1. **`hypav3.ts` — `addSummaryChunksContextual()`**
   전체 키를 제한 병렬(24)로 선조회해 Map 에 담고(미스 포함), 원 루프는 동기 조회.
2. **`hypamemory.ts` — `addText()`**
   순차 `for` → 배치 병렬(24). `this.vectors` push 순서는 원본과 동일하게 유지.
3. **`hypamemory.ts` — `prefetchPersistedHypaVectors()` 신설**
   서버의 `/api/assets/bulk-read` 는 **임의 KV 키를 받는다**(`kvGet(key)`, `assets/`
   제한 없음). `forageStorage.getItems()` 로 500키씩 묶어 한 번에 긁어와
   인메모리 캐시를 채운다. 실패하면 조용히 무시 — 기존 개별 조회가 폴백.

> ⚠️ **처음엔 `hypav3.ts` 만 고쳤는데 동시성이 여전히 1이었다.**
> 실제 hot path 는 `hypamemory.ts` 의 `addText()` 였다.
> 참고로 `hypamemoryv2.ts` 는 이미 `await Promise.all(loadPromises)` 로 병렬이다 —
> upstream 이 v2 만 고치고 v1/v3 경로는 남겨둔 상태.

## 실측 (tailscale 경유, 폰과 동일 조건)

| 단계 | 요청 | 최대 동시 | 소요 |
|---|---|---|---|
| 패치 전 | 개별 1,482건 | **1** | **431초** (7분 11초) |
| 1차 (병렬화만) | 개별 1,482건 | 24 | **35초** |
| **2차 (벌크 도입)** | **벌크 3건** | — | **0.31초** (각 52~56ms) |

로컬 직접 경로에서는 1차 패치 효과가 3.8초로 작게 보인다 — RTT 가 거의 0 이라
서버 CPU 가 병목이 되기 때문. **원격 조건에서 측정해야 효과가 드러난다.**

기능 회귀 없음: 메시지 정상 반영, job `done`, 2회 반복 재현.

## 롤백

```bash
docker compose build --no-cache \
  --build-arg NODEONLY_REF=v1.10.0 \
  --build-arg APPLY_HYPA_PARALLEL_PATCH=false risuai
docker compose up -d
```

## 알려진 한계

- **멱등성 처리 결함**: `hypav3` 가 이미 적용돼 있으면 스크립트가 조기 return 해
  `hypamemory` 패치를 건너뛴다. 도커 빌드는 항상 새 소스에서 시작하므로 실사용엔
  무해하지만, 부분 적용 상태에서 재실행하면 어긋난다. 정리 필요.
- upstream 갱신 시 anchor 검증 필요 (`node patches/hypa-parallel.cjs <staging>`).
- 근본 해결은 upstream 반영이다. 재현·측정·코드 위치가 모두 확보돼 있으므로
  이슈/PR 로 넘길 수 있다.

## 참고

- 사이드카 은퇴 경위: `docs/2026-08-22-llm-proxy-retirement.md`
- tailscale serve 가 요청마다 upstream 연결을 새로 여는 문제(요청 건수가 곧 비용):
  `/mnt/c/_scripts/v3/FORWARDER_INTEGRATION.md`, [tailscale#20875](https://github.com/tailscale/tailscale/issues/20875)
