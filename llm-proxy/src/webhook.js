/**
 * Webhook Dispatcher — Sends notifications on request completion/failure/cancel.
 *
 * Zero dependencies — uses Node.js built-in http/https modules.
 *
 * Configuration via environment variables:
 *   WEBHOOK_URL      — Target URL for webhook POST requests
 *   WEBHOOK_SECRET   — HMAC-SHA256 signing key (optional, for payload verification)
 *   WEBHOOK_EVENTS   — Comma-separated event list (default: "completed,failed,cancelled")
 *
 * Payload is signed with HMAC-SHA256 if WEBHOOK_SECRET is set.
 * Signature is sent in the X-Webhook-Signature header as "sha256=<hex>".
 *
 * Retry: 3 attempts with exponential backoff (2s, 4s, 8s).
 */

import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import * as log from './logger.js';

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const WEBHOOK_EVENTS = (process.env.WEBHOOK_EVENTS || 'completed,failed,cancelled')
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_RETRIES = 3;

/**
 * Check if webhooks are enabled.
 * @returns {boolean}
 */
export function isWebhookEnabled() {
  return WEBHOOK_URL.length > 0;
}

/**
 * Dispatch a webhook notification for a request event.
 *
 * @param {'completed'|'failed'|'cancelled'} event
 * @param {Object} data
 * @param {string} data.requestId
 * @param {string} [data.chatId]
 * @param {string} data.status
 * @param {number} [data.fullTextLength]
 * @param {string} [data.error]
 * @param {number} [data.tokensIn]
 * @param {number} [data.tokensOut]
 * @param {number} [data.estimatedCost]
 * @param {string} [data.model]
 */
export function dispatchWebhook(event, data) {
  if (!WEBHOOK_URL) return;
  if (!WEBHOOK_EVENTS.includes(event)) return;

  const payload = JSON.stringify({
    event: `request.${event}`,
    timestamp: new Date().toISOString(),
    ...data,
  });

  log.debug('webhook:dispatch', { event, requestId: data.requestId, url: WEBHOOK_URL });

  // Fire and forget — retry in background
  sendWithRetry(payload, 0).catch(err => {
    log.error('webhook:failed-all-retries', {
      event,
      requestId: data.requestId,
      error: err.message,
    });
  });
}

/**
 * Send webhook POST with retry logic.
 * @param {string} payload - JSON string
 * @param {number} attempt - Current attempt (0-based)
 * @returns {Promise<void>}
 */
async function sendWithRetry(payload, attempt) {
  try {
    await sendPost(payload);
    log.debug('webhook:sent', { attempt: attempt + 1 });
  } catch (err) {
    if (attempt < MAX_RETRIES - 1) {
      const delay = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
      log.warn('webhook:retry', {
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
        nextRetryMs: delay,
        error: err.message,
      });
      await sleep(delay);
      return sendWithRetry(payload, attempt + 1);
    }
    throw err;
  }
}

/**
 * Send a single POST request to the webhook URL.
 * @param {string} payload - JSON string
 * @returns {Promise<void>}
 */
function sendPost(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(WEBHOOK_URL);
    const isHttps = url.protocol === 'https:';
    const doRequest = isHttps ? httpsRequest : httpRequest;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': 'risuai-llm-proxy/0.1.0',
    };

    // HMAC-SHA256 signature
    if (WEBHOOK_SECRET) {
      const signature = createHmac('sha256', WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');
      headers['X-Webhook-Signature'] = `sha256=${signature}`;
    }

    const req = doRequest({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
      timeout: 10000,
    }, (res) => {
      // Consume response body to free socket
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`Webhook HTTP ${res.statusCode}`));
      }
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Webhook request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
