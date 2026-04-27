#!/usr/bin/env node
'use strict';
// RisuAI NodeOnly — LLM Proxy Source Patcher
// upstream 소스에 llm-proxy 연동 패치를 적용한다.
//
// 사용법 (Docker 빌드 내부 또는 로컬):
//   node patches/apply.cjs                 # 패치만 적용
//   node patches/apply.cjs <nodeonly-dir>  # 특정 디렉토리에 적용

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname);
let changed = 0;

function ok(msg) { console.log(`  [OK]    ${msg}`); }
function patched(msg) { console.log(`  [PATCH] ${msg}`); changed++; }
function warn(msg) { console.log(`  [WARN]  ${msg}`); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); }
function write(rel, content) { fs.writeFileSync(path.join(ROOT, rel), content, 'utf-8'); }

console.log(`=== RisuAI NodeOnly — LLM Proxy Patch ===`);
console.log(`Target: ${ROOT}\n`);

// ─── 1. index.html: proxy script 주입 ───
console.log('1/4 index.html');
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
console.log('2/4 src/ts/globalApi.svelte.ts');
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
console.log('3/4 server/node/server.cjs — compression skip');
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
console.log('4/4 server/node/server.cjs — reverse proxy route');
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

// ─── 필수 파일 확인 ───
console.log('\n--- 필수 파일 확인 ---');
if (exists('public/proxy-inject.js')) {
  ok('public/proxy-inject.js');
} else {
  warn('public/proxy-inject.js — 파일 없음! 빌드 전에 복사 필요');
  process.exit(1);
}

// ─── 결과 ───
console.log(`\n=== 결과: ${changed}개 패치 적용됨 ===`);
