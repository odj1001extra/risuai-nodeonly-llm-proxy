#!/usr/bin/env node
/**
 * HypaMemory 벡터 캐시 조회 병렬화 패치
 *
 * 문제: src/ts/process/memory/hypav3.ts 의 addSummaryChunksContextual() 이
 *   청크마다 `await getPersistedHypaVector(...)` 로 HTTP 1건씩 **순차** 조회한다.
 *   대화가 길면 수백~수천 왕복이 되고, 응답을 다 받은 뒤 메시지가 채팅에 붙기까지
 *   그만큼 지연된다(스피너만 도는 구간).
 *
 * 실측(2026-08-23, 6001):
 *   - /api/read 1,482건 순차, 로컬 3.95초 / 폰(tailscale DERP 릴레이) 약 2분
 *   - 메인스레드 블로킹은 총 411ms → CPU가 아니라 순수 왕복 대기
 *   - 6002는 hypa-vector 키가 0개라 미발생 (그래서 6001에서만 보였다)
 *
 * 수정: 조회들은 서로 완전히 독립적(순서 무관, 공유 상태 변경 없음)이므로
 *   전체 키를 먼저 제한 병렬로 프리페치해 Map 에 담고(미스도 기록),
 *   원 루프는 동기 조회만 하게 바꾼다. 의미는 100% 동일하다.
 *
 * 사용: node patches/hypa-parallel.cjs <소스루트>
 */
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || '.';
const file = 'src/ts/process/memory/hypav3.ts';
const full = path.join(root, file);

const ok      = (m) => console.log('  [OK]    ' + m);
const patched = (m) => console.log('  [PATCH] ' + m);
const warn    = (m) => { console.log('  [WARN]  ' + m); process.exitCode = 1; };

console.log('=== HypaMemory 벡터 조회 병렬화 패치 ===');
console.log('Target: ' + full);

if (!fs.existsSync(full)) { warn('대상 파일 없음: ' + file); return; }
let src = fs.readFileSync(full, 'utf8');

const MARK = '__hypaPrefetch';
if (src.includes(MARK)) { ok('이미 적용됨'); return; }

// --- anchor 1: 프리페치를 삽입할 지점 (그룹 루프 시작 직전) ---
const anchor1 = '        for (const [, group] of summaryGroups) {\n' +
                '            const groupTexts = group.map(c => c.text);\n' +
                '            let allCached = true;';
// --- anchor 2: 순차 조회 루프 (이걸 동기 조회로 교체) ---
const anchor2 = '            for (const chunk of group) {\n' +
                '                const cached: memoryVector = await getPersistedHypaVector(cacheKeyFor(chunk.text, groupTexts));\n' +
                '                if (cached) {\n' +
                '                    groupCache.set(chunk.text, cached);\n' +
                '                } else {\n' +
                '                    allCached = false;\n' +
                '                }\n' +
                '            }';

if (!src.includes(anchor1)) { warn('anchor 1 미발견 — upstream 구조 변경 의심'); return; }
if (!src.includes(anchor2)) { warn('anchor 2 미발견 — upstream 구조 변경 의심'); return; }
if (src.split(anchor2).length - 1 !== 1) { warn('anchor 2 가 유일하지 않음'); return; }

const prefetch =
'        // [hypa-parallel] 벡터 캐시 조회를 사전 병렬 프리페치로 대체.\n' +
'        //   원본은 청크마다 await 로 HTTP 1건씩 순차 조회해서, 긴 대화에서\n' +
'        //   수백~수천 왕복이 되고 원격 환경에선 수십초~수분이 걸렸다.\n' +
'        //   조회는 서로 독립적이라 순서 보장이 불필요하다. 미스도 기록해\n' +
'        //   아래 루프가 재조회하지 않게 한다(의미 동일, 왕복만 제거).\n' +
'        const ' + MARK + ' = new Map<string, memoryVector | undefined>();\n' +
'        {\n' +
'            const __keys: string[] = [];\n' +
'            for (const [, __g] of summaryGroups) {\n' +
'                const __gt = __g.map(c => c.text);\n' +
'                for (const __c of __g) {\n' +
'                    const __k = cacheKeyFor(__c.text, __gt);\n' +
'                    if (!' + MARK + '.has(__k)) { ' + MARK + '.set(__k, undefined); __keys.push(__k); }\n' +
'                }\n' +
'            }\n' +
'            const __CONC = 24; // 동시 요청 상한 (서버/브라우저 연결 수 보호)\n' +
'            for (let __i = 0; __i < __keys.length; __i += __CONC) {\n' +
'                const __slice = __keys.slice(__i, __i + __CONC);\n' +
'                const __got = await Promise.all(__slice.map(async (__k) => {\n' +
'                    try { return await getPersistedHypaVector(__k); } catch { return undefined; }\n' +
'                }));\n' +
'                for (let __j = 0; __j < __slice.length; __j++) ' + MARK + '.set(__slice[__j], __got[__j]);\n' +
'            }\n' +
'        }\n\n';

const replaced2 =
'            for (const chunk of group) {\n' +
'                const cached: memoryVector = ' + MARK + '.get(cacheKeyFor(chunk.text, groupTexts));\n' +
'                if (cached) {\n' +
'                    groupCache.set(chunk.text, cached);\n' +
'                } else {\n' +
'                    allCached = false;\n' +
'                }\n' +
'            }';

src = src.replace(anchor1, prefetch + anchor1);
patched('hypav3: 사전 병렬 프리페치 삽입');
src = src.replace(anchor2, replaced2);
patched('hypav3: 순차 조회 루프 → 프리페치 Map 동기 조회');
fs.writeFileSync(full, src, 'utf8');

// ── 2) hypamemory.ts : HypaProcesser.addText() ─────────────────────────────
//   실측상 이쪽이 실제 hot path 였다(최대 동시 1 → 완전 순차).
//   texts 배열을 순차 조회하며 this.vectors 에 push 한다. 배치 병렬로 바꾸되
//   push 순서는 원본과 동일하게 유지한다.
const file2 = 'src/ts/process/memory/hypamemory.ts';
const full2 = path.join(root, file2);
if (!fs.existsSync(full2)) { warn('대상 파일 없음: ' + file2); return; }
let src2 = fs.readFileSync(full2, 'utf8');

if (src2.includes('__hypaAddTextConc')) {
    ok('hypamemory: 이미 적용됨');
} else {
    const a3 =
'        for(let i=0;i<texts.length;i++){\n' +
'            const itm = await getPersistedHypaVector(texts[i] + \'|\' + this.model + suffix)\n' +
'            if(itm){\n' +
'                itm.alreadySaved = true\n' +
'                this.vectors.push(itm)\n' +
'            }\n' +
'        }';
    if (!src2.includes(a3)) { warn('hypamemory anchor 미발견 — upstream 구조 변경 의심'); return; }
    if (src2.split(a3).length - 1 !== 1) { warn('hypamemory anchor 가 유일하지 않음'); return; }

    const r3 =
'        // [hypa-parallel] 순차 await → 배치 병렬. 조회는 서로 독립적이고\n' +
'        //   this.vectors push 순서는 배치/배치내 순서로 원본과 동일하게 유지된다.\n' +
'        const __hypaAddTextConc = 24;\n' +
'        for(let __i=0;__i<texts.length;__i+=__hypaAddTextConc){\n' +
'            const __slice = texts.slice(__i, __i+__hypaAddTextConc)\n' +
'            const __got = await Promise.all(__slice.map(async (__t) => {\n' +
'                try { return await getPersistedHypaVector(__t + \'|\' + this.model + suffix) } catch { return undefined }\n' +
'            }))\n' +
'            for(const itm of __got){\n' +
'                if(itm){\n' +
'                    itm.alreadySaved = true\n' +
'                    this.vectors.push(itm)\n' +
'                }\n' +
'            }\n' +
'        }';
    src2 = src2.replace(a3, r3);
    fs.writeFileSync(full2, src2, 'utf8');
    patched('hypamemory: addText 순차 조회 → 배치 병렬');
}


// ── 3) hypamemory.ts : 벌크 프리페치 도입 ──────────────────────────────────
//   병렬화만으로는 요청 "건수"가 그대로라 한계가 있었다(tailscale 경유 35초).
//   서버의 /api/assets/bulk-read 는 임의 KV 키를 받으므로(assets/ 제한 없음)
//   forageStorage.getItems() 로 한 번에 긁어와 인메모리 캐시를 채운다.
//   → 1,482건 → 3건(500키 청크). getPersistedHypaVector 는 그대로 두고
//     캐시 히트만 유도하므로 의미 변화가 없다.
if (!src2.includes('prefetchPersistedHypaVectors')) {
    const impAnchor = 'import { makeHashedStorageKey, readPersistentJson, writePersistentJson } from "src/ts/storage/persistentKv";';
    if (!src2.includes(impAnchor)) { warn('hypamemory import anchor 미발견'); return; }
    src2 = src2.replace(impAnchor,
        impAnchor + '\nimport { forageStorage } from "src/ts/globalApi.svelte";');

    const fnAnchor = 'export async function setPersistedHypaVector(';
    if (!src2.includes(fnAnchor)) { warn('setPersistedHypaVector anchor 미발견'); return; }

    const bulkFn = [
'// [hypa-parallel] 벡터 캐시 벌크 프리페치.',
'//   원본은 청크마다 /api/read 1건씩 조회한다. 긴 대화에서 1,000건 이상이 되고',
'//   원격(모바일/릴레이)에서는 응답 수신 후 채팅 반영까지 수십초~수분이 걸렸다.',
'//   서버의 bulk-read 는 임의 KV 키를 받으므로 한 번에 긁어와 메모리 캐시를 채운다.',
'//   실패하면 조용히 무시 — 기존 개별 조회 경로가 그대로 폴백이 된다.',
'export async function prefetchPersistedHypaVectors(cacheKeys: string[]): Promise<void> {',
'    try {',
'        const need = Array.from(new Set(cacheKeys)).filter((k) => !hypaVectorCache.has(k))',
'        if (need.length === 0) return',
'        const anyStore: any = forageStorage as any',
'        if (typeof anyStore.getItems !== "function") return   // 백엔드가 벌크 미지원 → 폴백',
'        const pairs: { sk: string, ck: string }[] = []',
'        for (const ck of need) {',
'            pairs.push({ sk: await makeHashedStorageKey(hypaVectorCachePrefix, ck), ck })',
'        }',
'        const CHUNK = 500',
'        const dec = new TextDecoder()',
'        for (let i = 0; i < pairs.length; i += CHUNK) {',
'            const slice = pairs.slice(i, i + CHUNK)',
'            let got: { key: string, value: any }[]',
'            try { got = await anyStore.getItems(slice.map((p) => p.sk)) } catch { return }',
'            const bySk = new Map<string, any>()',
'            for (const g of (got || [])) bySk.set(g.key, g.value)',
'            for (const p of slice) {',
'                const raw = bySk.get(p.sk)',
'                if (!raw) continue',
'                try {',
'                    const payload = JSON.parse(dec.decode(raw)) as { key: string, value: memoryVector }',
'                    if (payload && payload.key === p.ck) hypaVectorCache.set(p.ck, payload.value)',
'                } catch { /* 개별 파싱 실패는 무시 → 개별 조회로 폴백 */ }',
'            }',
'        }',
'    } catch { /* 프리페치는 최적화일 뿐 — 실패해도 동작에 영향 없음 */ }',
'}',
'',
''].join('\n');
    src2 = src2.replace(fnAnchor, bulkFn + fnAnchor);
    patched('hypamemory: prefetchPersistedHypaVectors() 추가 (벌크 조회)');

    // addText 배치 병렬 루프 앞에 벌크 프리페치 호출을 넣는다
    const cAnchor = '        const __hypaAddTextConc = 24;';
    if (src2.includes(cAnchor)) {
        src2 = src2.replace(cAnchor,
'        await prefetchPersistedHypaVectors(texts.map((t) => t + \'|\' + this.model + suffix))\n' + cAnchor);
        patched('hypamemory: addText 에 벌크 프리페치 연결');
    } else { warn('addText 병렬 루프 anchor 미발견'); }

    fs.writeFileSync(full2, src2, 'utf8');
}

console.log('=== 완료 ===');