#!/usr/bin/env node
'use strict';
// RisuAI NodeOnly — LLM Proxy Patch
// 모바일 브라우저 백그라운드 전환 시 LLM 응답 유실 방지
//
// 사용법:
//   node apply-llm-proxy-patch.cjs          # 패치만 적용 (dry-run 확인용)
//   node apply-llm-proxy-patch.cjs --deploy # 패치 + 빌드 + 배포
//
// NodeOnly 업데이트 후 재적용 순서:
//   1. upstream 소스 업데이트 (git pull 등)
//   2. node apply-llm-proxy-patch.cjs --deploy

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname);
const deploy = process.argv.includes('--deploy');
let changed = 0;

function ok(msg) { console.log(`  [OK]    ${msg}`); }
function patched(msg) { console.log(`  [PATCH] ${msg}`); changed++; }
function warn(msg) { console.log(`  [WARN]  ${msg}`); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); }
function write(rel, content) { fs.writeFileSync(path.join(ROOT, rel), content, 'utf-8'); }

console.log('=== RisuAI NodeOnly — LLM Proxy Patch ===\n');

// ─── 1. index.html: proxy script 주입 ───
console.log('1/5 index.html');
{
  let c = read('index.html');
  if (c.includes('__LLM_PROXY_URL__')) {
    ok('proxy script 이미 주입됨');
  } else if (c.includes('</head>')) {
    c = c.replace(
      '</head>',
      "    <script>window.__LLM_PROXY_URL__ = '/llm-proxy';</script>\n" +
      '    <script src="/proxy-inject.js"></script>\n  </head>'
    );
    write('index.html', c);
    patched('proxy script 주입 완료');
  } else {
    warn('</head> 태그 미발견 — 수동 확인 필요');
  }
}

// ─── 2. globalApi.svelte.ts: !throughProxy 조건 제거 ───
console.log('2/5 src/ts/globalApi.svelte.ts');
{
  const file = 'src/ts/globalApi.svelte.ts';
  let c = read(file);
  if (c.includes('userScriptFetch && !throughProxy')) {
    c = c.replace(
      'window.userScriptFetch && !throughProxy',
      'window.userScriptFetch'
    );
    write(file, c);
    patched('!throughProxy 조건 제거');
  } else if (c.includes('if (window.userScriptFetch)')) {
    ok('!throughProxy 이미 제거됨');
  } else {
    warn('userScriptFetch 패턴 미발견 — 수동 확인 필요');
  }
}

// ─── 3. server.cjs: compression skip ───
console.log('3/5 server/node/server.cjs — compression skip');
{
  const file = 'server/node/server.cjs';
  let c = read(file);
  if (c.includes("startsWith('/llm-proxy')")) {
    ok('compression skip 이미 적용됨');
  } else if (c.includes("startsWith('/hub-proxy')")) {
    c = c.replace(
      "startsWith('/hub-proxy')",
      "startsWith('/hub-proxy') || url.startsWith('/llm-proxy')"
    );
    write(file, c);
    patched('/llm-proxy compression skip 추가');
  } else {
    warn('hub-proxy 패턴 미발견 — 수동 확인 필요');
  }
}

// ─── 4. server.cjs: reverse proxy route ───
console.log('4/5 server/node/server.cjs — reverse proxy route');
{
  const file = 'server/node/server.cjs';
  let c = read(file);
  if (c.includes('LLM_PROXY_TARGET')) {
    ok('reverse proxy route 이미 적용됨');
  } else {
    const proxyBlock = [
      '',
      '// LLM proxy — reverse proxy to sidecar (before express.json so raw body can be piped)',
      "const LLM_PROXY_TARGET = process.env.LLM_PROXY_URL || 'http://llm-proxy:6100';",
      "app.use('/llm-proxy', (req, res) => {",
      "    const target = new URL(req.url || '/', LLM_PROXY_TARGET);",
      '    const proxyReq = http.request({',
      '        hostname: target.hostname,',
      '        port: target.port,',
      '        path: target.pathname + target.search,',
      '        method: req.method,',
      '        headers: { ...req.headers, host: target.host },',
      '    }, (proxyRes) => {',
      '        res.writeHead(proxyRes.statusCode, proxyRes.headers);',
      '        proxyRes.pipe(res);',
      '    });',
      "    proxyReq.on('error', (err) => {",
      "        console.error('[llm-proxy]', err.message);",
      '        if (!res.headersSent) {',
      "            res.writeHead(502, { 'Content-Type': 'application/json' });",
      "            res.end(JSON.stringify({ error: 'LLM proxy unavailable' }));",
      '        }',
      '    });',
      '    req.pipe(proxyReq, { end: true });',
      '});',
      '',
    ].join('\n');

    const marker = 'app.use(express.json(';
    const idx = c.indexOf(marker);
    if (idx !== -1) {
      c = c.slice(0, idx) + proxyBlock + c.slice(idx);
      write(file, c);
      patched('reverse proxy route 추가');
    } else {
      warn('express.json() 삽입 지점 미발견 — 수동 확인 필요');
    }
  }
}

// ─── 5. docker-compose.yml: llm-proxy 서비스 ───
console.log('5/5 docker-compose.yml');
{
  let c = read('docker-compose.yml');
  if (c.includes('llm-proxy')) {
    ok('llm-proxy 서비스 이미 존재');
  } else if (c.includes('volumes:')) {
    const svcBlock =
      '    depends_on:\n' +
      '      - llm-proxy\n' +
      '\n' +
      '  llm-proxy:\n' +
      '    build: ./llm-proxy\n' +
      '    restart: always\n';
    const volumesIdx = c.lastIndexOf('\nvolumes:');
    if (volumesIdx !== -1) {
      c = c.slice(0, volumesIdx) + '\n' + svcBlock + c.slice(volumesIdx);
      write('docker-compose.yml', c);
      patched('llm-proxy 서비스 추가');
    } else {
      warn('volumes: 섹션 미발견 — 수동 확인 필요');
    }
  } else {
    warn('docker-compose.yml 구조 인식 불가 — 수동 확인 필요');
  }
}

// ─── 필수 파일 확인 ───
console.log('\n--- 필수 파일 확인 ---');
const required = [
  'public/proxy-inject.js',
  'llm-proxy/Dockerfile',
  'llm-proxy/package.json',
  'llm-proxy/src/index.js',
  'llm-proxy/src/relay.js',
  'llm-proxy/src/store.js',
];
let missing = false;
for (const f of required) {
  if (fs.existsSync(path.join(ROOT, f))) {
    ok(f);
  } else {
    warn(`${f} — 파일 없음!`);
    missing = true;
  }
}

// ─── 결과 ───
console.log(`\n=== 결과: ${changed}개 패치 적용됨 ===`);
if (missing) {
  console.log('\n필수 파일이 누락되었습니다.');
  console.log('llm-proxy/ 디렉토리와 public/proxy-inject.js를 확인하세요.');
  process.exit(1);
}

if (deploy) {
  console.log('\n빌드 중...');
  execSync('pnpm install && pnpm build', { stdio: 'inherit', cwd: ROOT });
  console.log('\n배포 중...');
  execSync('docker compose up -d --build', { stdio: 'inherit', cwd: ROOT });
  console.log('\n완료!');
} else if (changed > 0) {
  console.log('\n빌드 및 배포하려면:');
  console.log('  node apply-llm-proxy-patch.cjs --deploy');
}
