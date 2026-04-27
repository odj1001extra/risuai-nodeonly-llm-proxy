import http2 from 'node:http2';
import { pushChunk, completeBuffer, failBuffer, getBuffer, setUpstreamMeta, markStreaming } from './store.js';
import { createCostTracker } from './cost-tracker.js';
import { dispatchWebhook, isWebhookEnabled } from './webhook.js';
import { getRequestCost } from './cost-tracker.js';
import { Agent } from 'undici';
import * as log from './logger.js';

const MAX_RETRIES = parseInt(process.env.RELAY_MAX_RETRIES, 10) || 2;
const _rawTimeout = parseInt(process.env.RELAY_TIMEOUT_SECONDS, 10);
const RELAY_TIMEOUT_MS = Number.isNaN(_rawTimeout) ? 5 * 60_000 : _rawTimeout * 1000;

// Override undici's default headersTimeout (300s) to match relay timeout.
// Without this, Node.js fetch kills LLM requests that take >5min to respond.
const llmAgent = new Agent({
  headersTimeout: RELAY_TIMEOUT_MS,
  bodyTimeout: RELAY_TIMEOUT_MS,
});
const RETRY_BACKOFF = [2000, 4000, 8000, 16000];
const MAX_RESPONSE_BYTES = (parseInt(process.env.MAX_RESPONSE_MB, 10) || 128) * 1024 * 1024;

// --- HTTP/2 session pool ---
// Node.js fetch (undici) only supports HTTP/1.1. Google and other LLM APIs
// deprioritize HTTP/1.1 requests, causing 503s and severe latency.
// Using node:http2 directly achieves parity with browser performance.

/** @type {Map<string, import('node:http2').ClientHttp2Session>} */
const h2sessions = new Map();

function getH2Session(origin) {
  let session = h2sessions.get(origin);
  if (session && !session.closed && !session.destroyed) return session;

  session = http2.connect(origin);
  session.on('error', () => { h2sessions.delete(origin); });
  session.on('close', () => { h2sessions.delete(origin); });
  session.on('goaway', () => {
    session.close();
    h2sessions.delete(origin);
  });
  // Unref so idle sessions don't prevent process exit.
  // Server-side GOAWAY handles cleanup; no client-side idle timeout
  // to avoid killing long-running LLM requests.
  session.unref();
  h2sessions.set(origin, session);
  return session;
}

/**
 * HTTP/2 fetch — drop-in replacement for global fetch().
 * Returns a standard Response object compatible with the relay's existing code.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: string, signal?: AbortSignal }} options
 * @returns {Promise<Response>}
 */
function h2fetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DOMException('The operation was aborted', 'AbortError'));
    }

    const parsed = new URL(url);
    let session;
    try {
      session = getH2Session(parsed.origin);
    } catch (err) {
      return reject(err);
    }

    const reqHeaders = {
      ':method': method,
      ':path': parsed.pathname + parsed.search,
    };
    for (const [k, v] of Object.entries(headers)) {
      reqHeaders[k.toLowerCase()] = v;
    }

    const req = session.request(reqHeaders);
    let settled = false;

    // Abort signal
    const onAbort = () => {
      if (settled) return;
      settled = true;
      req.close(http2.constants.NGHTTP2_CANCEL);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    // Send body
    if (body) req.write(body);
    req.end();

    req.on('response', (resHeaders) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);

      const status = resHeaders[':status'];

      // Convert h2 headers → standard Headers
      const responseHeaders = new Headers();
      for (const [k, v] of Object.entries(resHeaders)) {
        if (!k.startsWith(':')) {
          responseHeaders.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        }
      }

      // Wrap h2 stream as ReadableStream for Response body
      const readable = new ReadableStream({
        start(controller) {
          req.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
          req.on('end', () => controller.close());
          req.on('error', (err) => {
            try { controller.error(err); } catch { /* already closed */ }
          });
        },
        cancel() {
          req.close(http2.constants.NGHTTP2_CANCEL);
        },
      });

      resolve(new Response(readable, { status, headers: responseHeaders }));
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

/**
 * Start fetching from the LLM API and buffer the streaming response.
 * Retries on transient server errors (5xx) with exponential backoff.
 *
 * @param {string} requestId
 */
export async function startRelay(requestId) {
  const buf = getBuffer(requestId);
  if (!buf) return;

  markStreaming(requestId);
  log.info('relay:start', { requestId, url: buf.url, method: buf.method });

  // Initialize cost tracker
  const costTracker = createCostTracker(requestId, buf.url, buf.body);

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (buf.abortController.signal.aborted) return;

    if (attempt > 0) {
      const delay = RETRY_BACKOFF[attempt - 1] || 16000;
      log.warn('relay:retry', { requestId, attempt, delayMs: delay, reason: lastError });
      await sleep(delay);
      if (buf.abortController.signal.aborted) return;
    }

    try {
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), RELAY_TIMEOUT_MS);

      // Combine user abort + timeout
      const combinedSignal = combineSignals(buf.abortController.signal, timeoutController.signal);

      // Use rawBody (pre-serialized string) when body is null (non-JSON request)
      const bodyPayload = buf.method === 'GET' ? undefined
        : buf.rawBody != null ? buf.rawBody
        : JSON.stringify(buf.body);

      const response = await h2fetch(buf.url, {
        method: buf.method,
        headers: buf.headers,
        body: bodyPayload,
        signal: combinedSignal,
        dispatcher: llmAgent,
      });

      clearTimeout(timeoutId);

      // Capture upstream response metadata for client forwarding
      const upstreamHeaders = {};
      response.headers.forEach((val, key) => { upstreamHeaders[key] = val; });
      setUpstreamMeta(requestId, response.status, upstreamHeaders);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const errMsg = `HTTP ${response.status}: ${errorBody.slice(0, 500)}`;

        // Retry on 5xx server errors, 429 rate limit
        if ((response.status >= 500 || response.status === 429) && attempt < MAX_RETRIES) {
          lastError = errMsg;
          continue;
        }

        log.error('relay:http-error', { requestId, status: response.status });
        // Finalize cost FIRST so failBuffer's addLogEntry sees finalized values
        costTracker.finalize();
        // Pass error body separately (not as chunk) so it doesn't mix with stream data
        failBuffer(requestId, errMsg, errorBody);
        emitWebhook('failed', requestId);
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      const isStream = contentType.includes('text/event-stream')
                     || contentType.includes('application/x-ndjson')
                     || contentType.includes('application/stream+json');

      if (isStream) {
        await consumeStream(requestId, response, combinedSignal, costTracker);
      } else {
        const text = await readResponseWithLimit(response, MAX_RESPONSE_BYTES);
        costTracker.processChunk(text);
        pushChunk(requestId, text);
        // Finalize cost BEFORE completeBuffer so addLogEntry sees finalized tokensIn/tokensOut
        costTracker.finalize();
        completeBuffer(requestId);
        emitWebhook('completed', requestId);
        log.info('relay:complete', { requestId, type: 'non-stream', bytes: text.length });
      }
      return; // success — no retry needed

    } catch (err) {
      if (err.name === 'AbortError') {
        if (buf.abortController.signal.aborted) {
          log.info('relay:cancelled', { requestId });
          return; // user-initiated cancel
        }
        // timeout
        lastError = 'Request timed out';
        if (attempt < MAX_RETRIES) continue;
        log.error('relay:timeout', { requestId, timeoutMs: RELAY_TIMEOUT_MS });
        costTracker.finalize();
        failBuffer(requestId, 'Request timed out');
        emitWebhook('failed', requestId);
        return;
      }
      lastError = err.message || String(err);
      if (attempt < MAX_RETRIES) continue;
      log.error('relay:fetch-error', { requestId, error: lastError });
      costTracker.finalize();
      failBuffer(requestId, err);
      emitWebhook('failed', requestId);
    }
  }
}

/**
 * Consume a streaming response (SSE or NDJSON), pushing raw lines
 * into the buffer. The original SSE format is preserved so the client
 * can parse it exactly as if it were talking to the LLM API directly.
 */
async function consumeStream(requestId, response, signal, costTracker) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let partial = '';
  let totalBytes = 0;

  try {
    while (true) {
      if (signal.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        log.error('relay:response-too-large', {
          requestId,
          totalMB: (totalBytes / 1048576).toFixed(1),
          limitMB: (MAX_RESPONSE_BYTES / 1048576).toFixed(0),
        });
        costTracker.finalize();
        failBuffer(requestId, `Response exceeded ${(MAX_RESPONSE_BYTES / 1048576).toFixed(0)}MB limit`);
        emitWebhook('failed', requestId);
        return;
      }

      const text = decoder.decode(value, { stream: true });
      partial += text;

      const lines = partial.split('\n');
      partial = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        costTracker.processChunk(trimmed);
        pushChunk(requestId, trimmed + '\n');
      }
    }

    if (partial.trim()) {
      pushChunk(requestId, partial.trim() + '\n');
    }

    const buf = getBuffer(requestId);
    // Finalize BEFORE completeBuffer so addLogEntry sees finalized tokens
    costTracker.finalize();
    completeBuffer(requestId);
    emitWebhook('completed', requestId);
    log.info('relay:complete', { requestId, type: 'stream', chunks: buf?.chunks.length ?? 0 });
  } catch (err) {
    if (err.name === 'AbortError') return;
    log.error('relay:stream-error', { requestId, error: err.message });
    costTracker.finalize();
    failBuffer(requestId, err);
    emitWebhook('failed', requestId);
  } finally {
    reader.releaseLock();
  }
}

/** Dispatch webhook with cost data */
function emitWebhook(event, requestId) {
  if (!isWebhookEnabled()) return;
  const buf = getBuffer(requestId);
  const cost = getRequestCost(requestId);
  dispatchWebhook(event, {
    requestId,
    chatId: buf?.chatId,
    status: buf?.status || event,
    fullTextLength: buf?.fullText?.length || 0,
    error: buf?.error || null,
    model: cost?.model,
    tokensIn: cost?.tokensIn || 0,
    tokensOut: cost?.tokensOut || 0,
    estimatedCost: cost?.estimatedCost || 0,
  });
}

/**
 * Read a response body as text with a byte limit.
 * Throws if the response exceeds maxBytes.
 */
async function readResponseWithLimit(response, maxBytes) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      reader.releaseLock();
      throw new Error(`Response exceeded ${(maxBytes / 1048576).toFixed(0)}MB limit`);
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  // Flush remaining
  chunks.push(decoder.decode());
  return chunks.join('');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Combine two AbortSignals — aborts when either fires */
function combineSignals(a, b) {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b]);
  }
  // Fallback for Node < 20.3
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}
