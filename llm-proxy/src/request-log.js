/**
 * Request Log — Persisted FIFO log of completed/failed/cancelled requests.
 *
 * Stores request/response data for the last N requests so they survive
 * BUFFER_TTL expiry and server restarts. Includes headers, truncated
 * request body, and truncated response body for debugging.
 *
 * Configuration:
 *   MAX_LOG_ENTRIES    — Maximum entries to keep (default: 100)
 *   LOG_BODY_MAX_CHARS — Truncation size (chars) for request/response body (default: 200_000)
 */

import * as log from './logger.js';

const MAX_LOG_ENTRIES = parseInt(process.env.MAX_LOG_ENTRIES, 10) || 100;
export const LOG_BODY_MAX_CHARS = parseInt(process.env.LOG_BODY_MAX_CHARS, 10) || 200_000;

/** @type {Array<Object>} oldest first */
let logEntries = [];

/**
 * Create a log entry from a completed RequestBuffer and optional cost data,
 * then append it to the in-memory log (FIFO, trimmed to MAX_LOG_ENTRIES).
 *
 * @param {import('./store.js').RequestBuffer} buf
 * @param {import('./cost-tracker.js').CostData} [costData]
 */
export function addLogEntry(buf, costData) {
  const createdAt = buf.createdAt instanceof Date
    ? buf.createdAt.toISOString()
    : String(buf.createdAt);
  const completedAt = buf.completedAt instanceof Date
    ? buf.completedAt.toISOString()
    : buf.completedAt ? String(buf.completedAt) : null;

  const duration = buf.completedAt && buf.createdAt
    ? new Date(buf.completedAt).getTime() - new Date(buf.createdAt).getTime()
    : null;

  // Truncate large strings for storage
  const truncate = (s, max) => {
    if (!s) return null;
    const str = typeof s === 'string' ? s : JSON.stringify(s, null, 2);
    if (!str) return null;
    if (str.length <= max) return str;
    return str.slice(0, max) + `\n\n... [truncated, ${str.length} total chars]`;
  };

  // Sanitize request headers — mask sensitive values
  let requestHeaders = null;
  if (buf.headers && Object.keys(buf.headers).length > 0) {
    requestHeaders = { ...buf.headers };
    for (const key of Object.keys(requestHeaders)) {
      const lk = key.toLowerCase();
      if (lk === 'authorization' || lk === 'x-api-key' || lk === 'api-key') {
        const v = requestHeaders[key];
        requestHeaders[key] = v && v.length > 12 ? v.slice(0, 8) + '...' + v.slice(-4) : '***';
      }
    }
  }

  const entry = {
    requestId: buf.requestId,
    chatId: buf.chatId || null,
    status: buf.status,
    url: buf.url,
    method: buf.method,
    model: costData?.model || null,
    provider: costData?.provider || null,
    tokensIn: costData?.tokensIn || 0,
    tokensOut: costData?.tokensOut || 0,
    estimatedCost: costData ? parseFloat(costData.estimatedCost.toFixed(6)) : 0,
    usageFromApi: costData?.usageFromApi || false,
    pricingTier: costData?.pricingTier || undefined,
    fullTextLength: buf.fullText?.length || 0,
    chunksReceived: buf.chunks?.length || 0,
    byteSizeKB: (buf.byteSize / 1024).toFixed(1),
    error: buf.error || null,
    errorBody: buf.errorBody || null,
    upstreamStatus: buf.upstreamStatus || null,
    createdAt,
    completedAt,
    duration,
    // Headers
    requestHeaders,
    upstreamHeaders: buf.upstreamHeaders && Object.keys(buf.upstreamHeaders).length > 0
      ? buf.upstreamHeaders : null,
    // Bodies (truncated, LOG_BODY_MAX_CHARS env)
    requestBody: truncate(buf.rawBody || buf.body, LOG_BODY_MAX_CHARS),
    responseBody: truncate(buf.fullText, LOG_BODY_MAX_CHARS),
  };

  logEntries.push(entry);

  // FIFO trim
  while (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.shift();
  }

  log.debug('request-log:added', {
    requestId: entry.requestId,
    status: entry.status,
    total: logEntries.length,
  });
}

/**
 * Get all log entries (oldest first).
 * @returns {Array<Object>}
 */
export function getLogEntries() {
  return logEntries;
}

/**
 * Get log state for persistence (called before save).
 * @returns {Array<Object>}
 */
export function getLogState() {
  return logEntries;
}

/**
 * Restore log state from persisted data (called on startup).
 * @param {Array<Object>} saved
 */
export function loadLogState(saved) {
  if (!Array.isArray(saved)) return;
  logEntries = saved;
  // Trim in case MAX_LOG_ENTRIES was reduced
  while (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.shift();
  }
  log.info('request-log:loaded', { entries: logEntries.length });
}

/**
 * Clear all log entries. Used by admin reset.
 */
export function resetLog() {
  logEntries = [];
}
