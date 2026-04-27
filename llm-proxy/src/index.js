import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBuffer, getBuffer, cancelBuffer, cancelAll, subscribe,
  listBuffers, cleanupExpired, getStoreStats, subscribeAdmin,
} from './store.js';
import { startRelay } from './relay.js';
import {
  getCostStats, getRequestCost, getAllCostData, removeCostData,
  getCostState, loadCostState, resetAllCosts,
} from './cost-tracker.js';
import { isWebhookEnabled, dispatchWebhook } from './webhook.js';
import { loadCostData, saveCostData, resetCostFile, loadRequestLog, saveRequestLog, resetRequestLogFile } from './persist.js';
import { getLogEntries, getLogState, loadLogState, resetLog, LOG_BODY_MAX_CHARS } from './request-log.js';
import * as log from './logger.js';
import { getRecentLogs } from './logger.js';

const PORT = parseInt(process.env.PORT, 10) || 6100;
const AUTH_KEY = process.env.PROXY_AUTH_KEY || '';
const KEEPALIVE_INTERVAL_MS = 5_000;
const CLEANUP_INTERVAL_MS = 60_000;
const MAX_BODY_BYTES = (parseInt(process.env.MAX_REQUEST_BODY_MB, 10) || 10) * 1024 * 1024;

// --- Helpers ---

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body too large (max ${MAX_BODY_BYTES / 1048576}MB)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function checkAuth(req, res) {
  if (!AUTH_KEY) return true;
  const provided = req.headers['x-proxy-auth'] || req.headers['risu-auth'] || '';
  if (provided !== AUTH_KEY) {
    log.warn('auth:rejected', { ip: req.socket.remoteAddress });
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

function extractPathAndQuery(url) {
  const qIdx = url.indexOf('?');
  const path = qIdx >= 0 ? url.slice(0, qIdx) : url;
  const query = qIdx >= 0 ? new URLSearchParams(url.slice(qIdx + 1)) : new URLSearchParams();
  return { path, query };
}

// --- Admin page ---

const __dirname = dirname(fileURLToPath(import.meta.url));
let adminHtml = null;
const ADMIN_HTML_PATHS = [
  resolve(__dirname, '../admin/proxy-admin.html'),   // Docker volume mount
  resolve(__dirname, '../inject/proxy-admin.html'),   // Local development
];

function loadAdminHtml() {
  for (const p of ADMIN_HTML_PATHS) {
    try {
      adminHtml = readFileSync(p, 'utf-8');
      return;
    } catch { /* try next */ }
  }
  adminHtml = null;
}
loadAdminHtml();

function handleAdmin(req, res) {
  // Always reload from disk (volume mount may update without restart)
  loadAdminHtml();
  if (!adminHtml) {
    sendJson(res, 404, { error: 'Admin page not found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(adminHtml),
    'Cache-Control': 'no-cache',
  });
  res.end(adminHtml);
}

/** GET /admin/events — SSE stream for admin dashboard live updates */
function handleAdminEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  // Send initial ping so the client knows the connection is alive
  res.write(':ok\n\n');

  const send = (event) => {
    if (!res.destroyed) res.write(`data: ${event}\n\n`);
  };

  const unsub = subscribeAdmin(send);

  // Keepalive every 15s (admin dashboard is not mobile-critical)
  const keepalive = setInterval(() => {
    if (!res.destroyed) res.write(':keepalive\n\n');
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepalive);
    unsub();
  });
}

// --- Route handlers ---

/** POST /request — Start a new LLM proxy request */
async function handleRequest(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  if (!body.url) {
    sendJson(res, 400, { error: 'Missing required field: url' });
    return;
  }

  // Basic URL validation
  try {
    new URL(body.url);
  } catch {
    sendJson(res, 400, { error: 'Invalid url' });
    return;
  }

  const buf = createBuffer({
    url: body.url,
    method: body.method || 'POST',
    headers: body.headers || {},
    body: body.body,
    rawBody: body.rawBody,
    chatId: body.chatId,
  });

  log.info('request:start', { requestId: buf.requestId, url: body.url, chatId: body.chatId });

  // Start relay in background (don't await)
  startRelay(buf.requestId);

  sendJson(res, 201, {
    requestId: buf.requestId,
    status: 'started',
  });
}

/** GET /stream/:requestId — SSE stream with reconnection support */
function handleStream(req, res, requestId, query) {
  const buf = getBuffer(requestId);
  if (!buf) {
    sendJson(res, 404, { error: 'Request not found' });
    return;
  }

  const offset = parseInt(query.get('offset'), 10) || 0;

  log.debug('stream:connect', { requestId, offset, bufferChunks: buf.chunks.length });

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  // Send buffered chunks from offset
  for (let i = offset; i < buf.chunks.length; i++) {
    const event = JSON.stringify({ index: i, chunk: buf.chunks[i], done: false });
    res.write(`data: ${event}\n\n`);
  }

  // If already done, send completion event and close
  if (buf.status === 'completed' || buf.status === 'failed' || buf.status === 'cancelled') {
    const final = buf.status === 'completed'
      ? { done: true, upstreamStatus: buf.upstreamStatus, upstreamHeaders: buf.upstreamHeaders }
      : buf.status === 'cancelled'
        ? { done: true, cancelled: true }
        : { done: true, error: buf.error, errorBody: buf.errorBody, upstreamStatus: buf.upstreamStatus, upstreamHeaders: buf.upstreamHeaders };
    res.write(`data: ${JSON.stringify(final)}\n\n`);
    res.end();
    return;
  }

  // Subscribe to live updates
  const send = (event) => {
    if (!res.destroyed) {
      res.write(`data: ${event}\n\n`);
      try {
        const parsed = JSON.parse(event);
        if (parsed.done) {
          res.end();
        }
      } catch { /* ignore */ }
    }
  };

  const unsub = subscribe(requestId, send);

  // Keepalive ping — send immediately, then repeat on interval
  // (mobile browsers may kill idle SSE connections within ~10-15s)
  if (!res.destroyed) res.write(`:keepalive\n\n`);
  const keepalive = setInterval(() => {
    if (!res.destroyed) {
      res.write(`:keepalive\n\n`);
    }
  }, KEEPALIVE_INTERVAL_MS);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    if (unsub) unsub();
    log.debug('stream:disconnect', { requestId });
  });
}

/** GET /status/:requestId — Request status */
function handleStatus(req, res, requestId) {
  const buf = getBuffer(requestId);
  if (!buf) {
    sendJson(res, 404, { error: 'Request not found' });
    return;
  }
  const cost = getRequestCost(requestId);
  sendJson(res, 200, {
    requestId: buf.requestId,
    chatId: buf.chatId,
    status: buf.status,
    chunksReceived: buf.chunks.length,
    fullTextLength: buf.fullText.length,
    byteSizeKB: (buf.byteSize / 1024).toFixed(1),
    error: buf.error || null,
    createdAt: buf.createdAt.toISOString(),
    completedAt: buf.completedAt?.toISOString() ?? null,
    cost: cost ? {
      model: cost.model,
      tokensIn: cost.tokensIn,
      tokensOut: cost.tokensOut,
      estimatedCost: parseFloat(cost.estimatedCost.toFixed(6)),
      usageFromApi: cost.usageFromApi,
    } : null,
  });
}

/** GET /detail/:requestId — Full request/response detail for debugging */
function handleDetail(req, res, requestId) {
  const buf = getBuffer(requestId);
  if (!buf) {
    sendJson(res, 404, { error: 'Request not found' });
    return;
  }
  const cost = getRequestCost(requestId);

  // Truncate large fields for safe transfer (same limit as persistent log)
  const truncate = (s, max) => {
    if (!s) return null;
    const str = typeof s === 'string' ? s : JSON.stringify(s, null, 2);
    if (!str) return null;
    if (str.length <= max) return str;
    return str.slice(0, max) + `\n\n... [truncated, ${str.length} total chars]`;
  };

  sendJson(res, 200, {
    requestId: buf.requestId,
    chatId: buf.chatId,
    status: buf.status,
    url: buf.url,
    method: buf.method,
    requestHeaders: buf.headers,
    requestBody: truncate(buf.rawBody || buf.body, LOG_BODY_MAX_CHARS),
    responseBody: truncate(buf.fullText, LOG_BODY_MAX_CHARS),
    upstreamStatus: buf.upstreamStatus,
    upstreamHeaders: buf.upstreamHeaders,
    chunksReceived: buf.chunks.length,
    fullTextLength: buf.fullText.length,
    byteSizeKB: (buf.byteSize / 1024).toFixed(1),
    error: buf.error || null,
    errorBody: buf.errorBody || null,
    createdAt: buf.createdAt.toISOString(),
    completedAt: buf.completedAt?.toISOString() ?? null,
    cost: cost ? {
      model: cost.model,
      provider: cost.provider,
      tokensIn: cost.tokensIn,
      tokensOut: cost.tokensOut,
      estimatedCost: parseFloat(cost.estimatedCost.toFixed(6)),
      usageFromApi: cost.usageFromApi,
      pricingTier: cost.pricingTier,
    } : null,
  });
}

/** POST /cancel/:requestId — Cancel a running request */
function handleCancel(req, res, requestId) {
  const buf = getBuffer(requestId);
  if (!buf) {
    sendJson(res, 404, { error: 'Request not found' });
    return;
  }
  const cancelled = cancelBuffer(requestId);
  if (cancelled && isWebhookEnabled()) {
    const cost = getRequestCost(requestId);
    dispatchWebhook('cancelled', {
      requestId,
      chatId: buf.chatId,
      status: 'cancelled',
      fullTextLength: buf.fullText.length,
      model: cost?.model,
      tokensIn: cost?.tokensIn || 0,
      tokensOut: cost?.tokensOut || 0,
      estimatedCost: cost?.estimatedCost || 0,
    });
  }
  sendJson(res, 200, {
    requestId,
    status: cancelled ? 'cancelled' : buf.status,
    message: cancelled ? 'Request cancelled' : 'Request already finished',
  });
}

/** GET /requests — List all active requests (with cost/model metadata) */
function handleList(req, res) {
  const requests = listBuffers().map(r => {
    const cost = getRequestCost(r.requestId);
    if (cost) {
      r.model = cost.model;
      r.provider = cost.provider;
      r.tokensIn = cost.tokensIn || 0;
      r.tokensOut = cost.tokensOut || 0;
    }
    return r;
  });
  sendJson(res, 200, { requests });
}

/** GET /metrics/cost — Aggregate cost statistics */
function handleCostMetrics(req, res) {
  sendJson(res, 200, getCostStats());
}

/** GET /metrics/cost/:requestId — Cost data for a specific request */
function handleRequestCost(req, res, requestId) {
  const cost = getRequestCost(requestId);
  if (!cost) {
    sendJson(res, 404, { error: 'Cost data not found' });
    return;
  }
  sendJson(res, 200, {
    ...cost,
    estimatedCost: parseFloat(cost.estimatedCost.toFixed(6)),
  });
}

/** GET /metrics/cost/all — All tracked cost data */
function handleAllCosts(req, res) {
  const all = getAllCostData().map(c => ({
    ...c,
    estimatedCost: parseFloat(c.estimatedCost.toFixed(6)),
  }));
  sendJson(res, 200, { costs: all });
}

/** GET /health — Health check */
function handleHealth(req, res) {
  sendJson(res, 200, {
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    ...getStoreStats(),
    cost: getCostStats(),
    webhook: isWebhookEnabled() ? 'enabled' : 'disabled',
  });
}

/** GET /logs — Recent log entries (query: ?level=info&limit=200) */
function handleLogs(req, res, query) {
  const level = query.get('level') || undefined;
  const limit = parseInt(query.get('limit'), 10) || 200;
  sendJson(res, 200, { logs: getRecentLogs({ level, limit }) });
}

/** GET /config — Current configuration (env vars) */
function handleConfig(req, res) {
  sendJson(res, 200, {
    port: PORT,
    authEnabled: !!AUTH_KEY,
    authKey: AUTH_KEY || null,
    bufferTTLMinutes: parseInt(process.env.BUFFER_TTL_MINUTES, 10) || 30,
    maxConcurrentRequests: parseInt(process.env.MAX_CONCURRENT_REQUESTS, 10) || 200,
    maxBufferSizeMB: parseInt(process.env.MAX_BUFFER_SIZE_MB, 10) || 512,
    maxRequestBodyMB: parseInt(process.env.MAX_REQUEST_BODY_MB, 10) || 10,
    relayTimeoutSeconds: parseInt(process.env.RELAY_TIMEOUT_SECONDS, 10) || 300,
    relayMaxRetries: parseInt(process.env.RELAY_MAX_RETRIES, 10) || 2,
    logLevel: process.env.LOG_LEVEL || 'info',
    webhookUrl: process.env.WEBHOOK_URL || null,
    webhookSecret: process.env.WEBHOOK_SECRET || null,
    webhookEvents: process.env.WEBHOOK_EVENTS || 'completed,failed,cancelled',
    redisUrl: process.env.REDIS_URL || null,
    redisKeyPrefix: process.env.REDIS_KEY_PREFIX || 'llm-proxy',
    maxLogEntries: parseInt(process.env.MAX_LOG_ENTRIES, 10) || 100,
    logBodyMaxChars: LOG_BODY_MAX_CHARS,
    costPricingJson: process.env.COST_PRICING_JSON || null,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    memoryUsageMB: {
      rss: (process.memoryUsage().rss / 1048576).toFixed(1),
      heapUsed: (process.memoryUsage().heapUsed / 1048576).toFixed(1),
      heapTotal: (process.memoryUsage().heapTotal / 1048576).toFixed(1),
    },
  });
}

// --- Persistence helpers ---

const SAVE_INTERVAL_MS = 60_000;

function persistAll() {
  saveCostData(getCostState());
  saveRequestLog(getLogState());
}

/** POST /admin/reset — Reset all persisted data */
function handleAdminReset(req, res) {
  resetAllCosts();
  resetCostFile();
  resetLog();
  resetRequestLogFile();
  log.info('admin:reset', { action: 'all-data-cleared' });
  sendJson(res, 200, { message: 'All data has been reset' });
}

/** GET /requests/history — Persisted request log (newest first) */
function handleRequestHistory(req, res, query) {
  const limit = parseInt(query.get('limit'), 10) || 100;
  const offset = parseInt(query.get('offset'), 10) || 0;
  const entries = getLogEntries();
  const reversed = entries.slice().reverse();
  const page = reversed.slice(offset, offset + limit);
  sendJson(res, 200, {
    total: entries.length,
    maxEntries: parseInt(process.env.MAX_LOG_ENTRIES, 10) || 100,
    entries: page,
  });
}

// --- Server ---

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-proxy-auth, risu-auth',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (!checkAuth(req, res)) return;

  const { path, query } = extractPathAndQuery(req.url);

  try {
    // POST /request
    if (req.method === 'POST' && path === '/request') {
      await handleRequest(req, res);
      return;
    }

    // GET /stream/:requestId
    const streamMatch = path.match(/^\/stream\/(.+)$/);
    if (req.method === 'GET' && streamMatch) {
      handleStream(req, res, streamMatch[1], query);
      return;
    }

    // GET /status/:requestId
    const statusMatch = path.match(/^\/status\/(.+)$/);
    if (req.method === 'GET' && statusMatch) {
      handleStatus(req, res, statusMatch[1]);
      return;
    }

    // GET /detail/:requestId
    const detailMatch = path.match(/^\/detail\/(.+)$/);
    if (req.method === 'GET' && detailMatch) {
      handleDetail(req, res, detailMatch[1]);
      return;
    }

    // POST /cancel/:requestId
    const cancelMatch = path.match(/^\/cancel\/(.+)$/);
    if (req.method === 'POST' && cancelMatch) {
      handleCancel(req, res, cancelMatch[1]);
      return;
    }

    // GET /metrics/cost/all
    if (req.method === 'GET' && path === '/metrics/cost/all') {
      handleAllCosts(req, res);
      return;
    }

    // GET /metrics/cost/:requestId
    const costMatch = path.match(/^\/metrics\/cost\/(.+)$/);
    if (req.method === 'GET' && costMatch) {
      handleRequestCost(req, res, costMatch[1]);
      return;
    }

    // GET /metrics/cost
    if (req.method === 'GET' && path === '/metrics/cost') {
      handleCostMetrics(req, res);
      return;
    }

    // GET /requests/history
    if (req.method === 'GET' && path === '/requests/history') {
      handleRequestHistory(req, res, query);
      return;
    }

    // GET /requests
    if (req.method === 'GET' && path === '/requests') {
      handleList(req, res);
      return;
    }

    // GET /admin/events — SSE live updates for dashboard
    if (req.method === 'GET' && path === '/admin/events') {
      handleAdminEvents(req, res);
      return;
    }

    // GET /admin — Dashboard page
    if (req.method === 'GET' && path === '/admin') {
      handleAdmin(req, res);
      return;
    }

    // POST /admin/reset — Clear all persisted data
    if (req.method === 'POST' && path === '/admin/reset') {
      handleAdminReset(req, res);
      return;
    }

    // GET /logs
    if (req.method === 'GET' && path === '/logs') {
      handleLogs(req, res, query);
      return;
    }

    // GET /config
    if (req.method === 'GET' && path === '/config') {
      handleConfig(req, res);
      return;
    }

    // GET /health
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      handleHealth(req, res);
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    log.error('request:error', { path, method: req.method, error: err.message });
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }
});

// Periodic cleanup + persistence
const cleanupTimer = setInterval(cleanupExpired, CLEANUP_INTERVAL_MS);
const saveTimer = setInterval(persistAll, SAVE_INTERVAL_MS);

// --- Load persisted data ---

const savedCosts = loadCostData();
if (savedCosts) {
  loadCostState(savedCosts);
}

const savedLog = loadRequestLog();
if (savedLog) {
  loadLogState(savedLog);
}

// --- Graceful shutdown ---

function shutdown(signal) {
  log.info('shutdown:start', { signal });
  clearInterval(cleanupTimer);
  clearInterval(saveTimer);
  persistAll();
  cancelAll();
  server.close(() => {
    log.info('shutdown:complete');
    process.exit(0);
  });
  // Force exit after 5s if connections linger
  setTimeout(() => {
    log.warn('shutdown:forced');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Start ---

server.listen(PORT, () => {
  log.info('server:start', {
    port: PORT,
    auth: AUTH_KEY ? 'enabled' : 'disabled',
    bufferTTL: `${process.env.BUFFER_TTL_MINUTES || 30}m`,
    maxRequests: process.env.MAX_CONCURRENT_REQUESTS || 200,
    maxMemoryMB: process.env.MAX_BUFFER_SIZE_MB || 512,
    maxBodyMB: process.env.MAX_REQUEST_BODY_MB || 10,
    relayTimeout: `${process.env.RELAY_TIMEOUT_SECONDS || 300}s`,
    relayRetries: process.env.RELAY_MAX_RETRIES || 2,
    logLevel: process.env.LOG_LEVEL || 'info',
    webhook: isWebhookEnabled() ? process.env.WEBHOOK_URL : 'disabled',
    costTracking: 'enabled',
    redis: process.env.REDIS_URL ? 'enabled' : 'disabled',
  });
});
