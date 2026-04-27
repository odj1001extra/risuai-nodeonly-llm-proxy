import { randomUUID } from 'node:crypto';
import * as log from './logger.js';
import { addLogEntry } from './request-log.js';
import { getRequestCost } from './cost-tracker.js';

/**
 * @typedef {'pending'|'streaming'|'completed'|'failed'|'cancelled'} RequestStatus
 *
 * @typedef {Object} RequestBuffer
 * @property {string} requestId
 * @property {string} [chatId]
 * @property {RequestStatus} status
 * @property {string} url
 * @property {string} method
 * @property {Record<string,string>} headers
 * @property {any} body
 * @property {string[]} chunks          - raw SSE lines / response chunks
 * @property {string} fullText          - accumulated plain text
 * @property {number} byteSize          - approximate memory usage in bytes
 * @property {string} [error]
 * @property {string} [errorBody]           - upstream error response body (not mixed into chunks)
 * @property {AbortController} abortController
 * @property {Date} createdAt
 * @property {Date} [completedAt]
 * @property {number|null} [upstreamStatus]  - upstream HTTP status code
 * @property {Record<string,string>} [upstreamHeaders] - upstream response headers
 * @property {Set<(event: string) => void>} subscribers
 * @property {number} [expiresAt]       - epoch ms, set after completion
 */

const BUFFER_TTL_MS    = (parseInt(process.env.BUFFER_TTL_MINUTES, 10) || 30) * 60_000;
const MAX_BUFFERS      = parseInt(process.env.MAX_CONCURRENT_REQUESTS, 10) || 200;
const MAX_MEMORY_BYTES = (parseInt(process.env.MAX_BUFFER_SIZE_MB, 10) || 512) * 1024 * 1024;

/** @type {Map<string, RequestBuffer>} */
const buffers = new Map();

/** Total approximate memory used by all buffers */
let totalByteSize = 0;

// --- Admin event subscribers ---
/** @type {Set<(event: string) => void>} */
const adminSubscribers = new Set();

/** Subscribe to admin-level store events. Returns unsubscribe function. */
export function subscribeAdmin(sendFn) {
  adminSubscribers.add(sendFn);
  return () => adminSubscribers.delete(sendFn);
}

/** Emit an event to all admin subscribers */
function adminEmit(type, requestId, extra) {
  if (adminSubscribers.size === 0) return;
  const event = JSON.stringify({ type, requestId, ts: Date.now(), ...extra });
  for (const send of adminSubscribers) {
    try { send(event); } catch { adminSubscribers.delete(send); }
  }
}

/** Create a new request buffer and return its id */
export function createBuffer({ url, method, headers, body, rawBody, chatId }) {
  while (buffers.size >= MAX_BUFFERS || totalByteSize >= MAX_MEMORY_BYTES) {
    if (!evictOldest()) break;
  }

  const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  /** @type {RequestBuffer} */
  const buf = {
    requestId,
    chatId: chatId || undefined,
    status: 'pending',
    url,
    method: method || 'POST',
    headers: headers || {},
    body,
    rawBody: rawBody || undefined,
    chunks: [],
    fullText: '',
    byteSize: 0,
    error: undefined,
    errorBody: undefined,
    abortController: new AbortController(),
    createdAt: new Date(),
    completedAt: undefined,
    upstreamStatus: null,
    upstreamHeaders: {},
    subscribers: new Set(),
    expiresAt: undefined,
  };
  buffers.set(requestId, buf);
  log.debug('store:create', { requestId, chatId, url });
  adminEmit('created', requestId, { url, chatId });
  return buf;
}

/** @returns {RequestBuffer|undefined} */
export function getBuffer(requestId) {
  return buffers.get(requestId);
}

/** Store upstream HTTP response metadata for later forwarding to client */
export function setUpstreamMeta(requestId, status, headers) {
  const buf = buffers.get(requestId);
  if (!buf) return;
  buf.upstreamStatus = status;
  buf.upstreamHeaders = headers || {};
}

/** Mark buffer as streaming and notify admin */
export function markStreaming(requestId) {
  const buf = buffers.get(requestId);
  if (!buf || buf.status === 'streaming') return;
  buf.status = 'streaming';
  adminEmit('streaming', requestId);
}

/** Push a raw chunk string into the buffer and notify subscribers */
export function pushChunk(requestId, chunkText) {
  const buf = buffers.get(requestId);
  if (!buf) return;

  const chunkBytes = Buffer.byteLength(chunkText);
  buf.byteSize += chunkBytes;
  totalByteSize += chunkBytes;

  const index = buf.chunks.length;
  buf.chunks.push(chunkText);
  buf.fullText += chunkText;

  // Evict if memory limit exceeded
  if (totalByteSize > MAX_MEMORY_BYTES) {
    log.warn('store:memory-pressure', {
      totalMB: (totalByteSize / 1048576).toFixed(1),
      limitMB: (MAX_MEMORY_BYTES / 1048576).toFixed(0),
    });
    evictOldest();
  }

  const event = JSON.stringify({ index, chunk: chunkText, done: false });
  for (const send of buf.subscribers) {
    try { send(event); } catch { /* subscriber gone */ }
  }
}

/** Mark buffer as completed and schedule cleanup */
export function completeBuffer(requestId) {
  const buf = buffers.get(requestId);
  if (!buf) return;
  buf.status = 'completed';
  buf.completedAt = new Date();
  buf.expiresAt = Date.now() + BUFFER_TTL_MS;

  const event = JSON.stringify({
    done: true,
    upstreamStatus: buf.upstreamStatus,
    upstreamHeaders: buf.upstreamHeaders,
  });
  for (const send of buf.subscribers) {
    try { send(event); } catch { /* subscriber gone */ }
  }
  buf.subscribers.clear();

  addLogEntry(buf, getRequestCost(requestId));
  adminEmit('completed', requestId, { bytes: buf.byteSize });
}

/** Mark buffer as failed */
export function failBuffer(requestId, error, errorBody) {
  const buf = buffers.get(requestId);
  if (!buf) return;
  buf.status = 'failed';
  buf.error = typeof error === 'string' ? error : (error?.message ?? String(error));
  buf.errorBody = typeof errorBody === 'string' ? errorBody : undefined;
  buf.completedAt = new Date();
  buf.expiresAt = Date.now() + BUFFER_TTL_MS;

  log.warn('store:failed', { requestId, error: buf.error });

  const event = JSON.stringify({
    done: true,
    error: buf.error,
    errorBody: buf.errorBody,
    upstreamStatus: buf.upstreamStatus,
    upstreamHeaders: buf.upstreamHeaders,
  });
  for (const send of buf.subscribers) {
    try { send(event); } catch { /* subscriber gone */ }
  }
  buf.subscribers.clear();

  addLogEntry(buf, getRequestCost(requestId));
  adminEmit('failed', requestId, { error: buf.error });
}

/** Cancel a request */
export function cancelBuffer(requestId) {
  const buf = buffers.get(requestId);
  if (!buf) return false;
  if (buf.status === 'completed' || buf.status === 'failed' || buf.status === 'cancelled') {
    return false;
  }
  buf.abortController.abort();
  buf.status = 'cancelled';
  buf.completedAt = new Date();
  buf.expiresAt = Date.now() + BUFFER_TTL_MS;

  log.info('store:cancelled', { requestId });

  const event = JSON.stringify({ done: true, cancelled: true });
  for (const send of buf.subscribers) {
    try { send(event); } catch { /* subscriber gone */ }
  }
  buf.subscribers.clear();

  addLogEntry(buf, getRequestCost(requestId));
  adminEmit('cancelled', requestId);
  return true;
}

/** Add a subscriber callback. Returns unsubscribe function. */
export function subscribe(requestId, sendFn) {
  const buf = buffers.get(requestId);
  if (!buf) return null;
  buf.subscribers.add(sendFn);
  return () => buf.subscribers.delete(sendFn);
}

/** List all active/recent buffers (summary only) */
export function listBuffers() {
  const result = [];
  for (const buf of buffers.values()) {
    result.push({
      requestId: buf.requestId,
      chatId: buf.chatId,
      status: buf.status,
      url: buf.url,
      chunksReceived: buf.chunks.length,
      fullTextLength: buf.fullText.length,
      byteSizeKB: (buf.byteSize / 1024).toFixed(1),
      createdAt: buf.createdAt.toISOString(),
      completedAt: buf.completedAt?.toISOString() ?? null,
    });
  }
  return result;
}

/** Remove expired buffers. Called periodically. */
export function cleanupExpired() {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, buf] of buffers) {
    if (buf.expiresAt && now > buf.expiresAt) {
      totalByteSize -= buf.byteSize;
      buffers.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log.debug('store:cleanup', { cleaned, remaining: buffers.size });
  }
}

/** Evict the oldest completed buffer to make room. Returns true if evicted. */
function evictOldest() {
  let oldestId = null;
  let oldestTime = Infinity;

  // Prefer evicting completed/failed/cancelled first
  for (const [id, buf] of buffers) {
    if ((buf.status === 'completed' || buf.status === 'failed' || buf.status === 'cancelled')
        && buf.createdAt.getTime() < oldestTime) {
      oldestTime = buf.createdAt.getTime();
      oldestId = id;
    }
  }
  // If none completed, evict the oldest regardless
  if (!oldestId) {
    for (const [id, buf] of buffers) {
      if (buf.createdAt.getTime() < oldestTime) {
        oldestTime = buf.createdAt.getTime();
        oldestId = id;
      }
    }
  }
  if (oldestId) {
    const buf = buffers.get(oldestId);
    if (buf && (buf.status === 'pending' || buf.status === 'streaming')) {
      buf.abortController.abort();
    }
    totalByteSize -= buf.byteSize;
    buffers.delete(oldestId);
    log.debug('store:evict', { requestId: oldestId, freedKB: (buf.byteSize / 1024).toFixed(1) });
    return true;
  }
  return false;
}

/** Cancel all active requests (for graceful shutdown) */
export function cancelAll() {
  for (const [, buf] of buffers) {
    if (buf.status === 'pending' || buf.status === 'streaming') {
      buf.abortController.abort();
      buf.status = 'cancelled';
      buf.completedAt = new Date();
      const event = JSON.stringify({ done: true, cancelled: true });
      for (const send of buf.subscribers) {
        try { send(event); } catch { /* ignore */ }
      }
      buf.subscribers.clear();
      addLogEntry(buf, getRequestCost(id));
    }
  }
}

export function getStoreStats() {
  return {
    total: buffers.size,
    memoryMB: (totalByteSize / 1048576).toFixed(1),
    memoryBytes: totalByteSize,
    memoryLimitMB: (MAX_MEMORY_BYTES / 1048576).toFixed(0),
    memoryLimitBytes: MAX_MEMORY_BYTES,
    pending: [...buffers.values()].filter(b => b.status === 'pending').length,
    streaming: [...buffers.values()].filter(b => b.status === 'streaming').length,
    completed: [...buffers.values()].filter(b => b.status === 'completed').length,
    failed: [...buffers.values()].filter(b => b.status === 'failed').length,
    cancelled: [...buffers.values()].filter(b => b.status === 'cancelled').length,
  };
}
