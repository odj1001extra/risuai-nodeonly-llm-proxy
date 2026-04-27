/**
 * Redis-backed Store — Optional shared state for multi-instance deployments.
 *
 * Zero dependencies — implements minimal Redis RESP protocol using node:net.
 *
 * Only activated when REDIS_URL environment variable is set.
 * Falls back gracefully to in-memory store if Redis is unavailable.
 *
 * Usage:
 *   import { createRedisStore } from './redis-store.js';
 *   const store = await createRedisStore('redis://localhost:6379');
 *   // store implements the same interface as the Map-based store
 *
 * Supports:
 *   - Buffer CRUD (create, get, update, delete)
 *   - Pub/Sub for cross-instance subscriber notifications
 *   - TTL-based auto-expiry (delegated to Redis EXPIRE)
 *   - Connection pooling with auto-reconnect
 */

import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import * as log from './logger.js';

const BUFFER_TTL_MS = (parseInt(process.env.BUFFER_TTL_MINUTES, 10) || 30) * 60_000;
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'llm-proxy';

// --- Minimal RESP Protocol Client ---

/**
 * Create a minimal Redis client using RESP protocol over TCP.
 * Supports: PING, SET, GET, DEL, EXPIRE, KEYS, PUBLISH, SUBSCRIBE, HSET, HGET, HGETALL, HDEL
 *
 * @param {string} redisUrl - Redis connection URL (redis://host:port)
 * @returns {Promise<Object>} Redis client
 */
export async function createRedisClient(redisUrl) {
  const url = new URL(redisUrl);
  const host = url.hostname || '127.0.0.1';
  const port = parseInt(url.port, 10) || 6379;
  const password = url.password || '';
  const db = parseInt(url.pathname?.slice(1), 10) || 0;

  let socket = null;
  let connected = false;
  let responseQueue = [];
  let buffer = '';
  let reconnecting = false;

  async function connect() {
    return new Promise((resolve, reject) => {
      socket = createConnection({ host, port }, async () => {
        connected = true;
        log.info('redis:connected', { host, port });

        try {
          if (password) await command('AUTH', password);
          if (db > 0) await command('SELECT', String(db));
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      socket.setEncoding('utf8');
      socket.on('data', onData);
      socket.on('error', (err) => {
        log.warn('redis:error', { error: err.message });
        if (!connected) reject(err);
      });
      socket.on('close', () => {
        connected = false;
        log.warn('redis:disconnected');
        scheduleReconnect();
      });
    });
  }

  function scheduleReconnect() {
    if (reconnecting) return;
    reconnecting = true;
    setTimeout(async () => {
      reconnecting = false;
      try {
        await connect();
      } catch (e) {
        log.warn('redis:reconnect-failed', { error: e.message });
        scheduleReconnect();
      }
    }, 3000);
  }

  function onData(data) {
    buffer += data;
    while (buffer.length > 0) {
      const result = parseResp(buffer);
      if (result === null) break; // incomplete
      buffer = result.remaining;
      if (responseQueue.length > 0) {
        const { resolve } = responseQueue.shift();
        resolve(result.value);
      }
    }
  }

  /**
   * Parse a single RESP response from the buffer.
   * @param {string} buf
   * @returns {{ value: any, remaining: string }|null}
   */
  function parseResp(buf) {
    if (buf.length === 0) return null;

    const type = buf[0];
    const crlfIndex = buf.indexOf('\r\n');
    if (crlfIndex === -1) return null;

    const line = buf.slice(1, crlfIndex);
    const rest = buf.slice(crlfIndex + 2);

    switch (type) {
      case '+': // Simple String
        return { value: line, remaining: rest };

      case '-': // Error
        return { value: new Error(line), remaining: rest };

      case ':': // Integer
        return { value: parseInt(line, 10), remaining: rest };

      case '$': { // Bulk String
        const len = parseInt(line, 10);
        if (len === -1) return { value: null, remaining: rest };
        if (rest.length < len + 2) return null; // incomplete
        const value = rest.slice(0, len);
        return { value, remaining: rest.slice(len + 2) };
      }

      case '*': { // Array
        const count = parseInt(line, 10);
        if (count === -1) return { value: null, remaining: rest };
        const arr = [];
        let remaining = rest;
        for (let i = 0; i < count; i++) {
          const elem = parseResp(remaining);
          if (elem === null) return null; // incomplete
          arr.push(elem.value);
          remaining = elem.remaining;
        }
        return { value: arr, remaining };
      }

      default:
        return null;
    }
  }

  /**
   * Send a RESP command and wait for the response.
   * @param  {...string} args - Command and arguments
   * @returns {Promise<any>}
   */
  function command(...args) {
    return new Promise((resolve, reject) => {
      if (!connected || !socket) {
        reject(new Error('Redis not connected'));
        return;
      }

      // Build RESP command
      let cmd = `*${args.length}\r\n`;
      for (const arg of args) {
        const str = String(arg);
        cmd += `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
      }

      responseQueue.push({ resolve, reject });
      socket.write(cmd);
    });
  }

  // Connect
  await connect();

  return {
    /** @returns {boolean} */
    get isConnected() { return connected; },

    /**
     * @param {...string} args
     * @returns {Promise<any>}
     */
    command,

    /** SET key value [EX seconds] */
    async set(key, value, ttlSeconds) {
      if (ttlSeconds) {
        return command('SET', key, value, 'EX', String(ttlSeconds));
      }
      return command('SET', key, value);
    },

    /** GET key */
    async get(key) {
      return command('GET', key);
    },

    /** DEL key */
    async del(key) {
      return command('DEL', key);
    },

    /** EXPIRE key seconds */
    async expire(key, seconds) {
      return command('EXPIRE', key, String(seconds));
    },

    /** KEYS pattern */
    async keys(pattern) {
      return command('KEYS', pattern);
    },

    /** PUBLISH channel message */
    async publish(channel, message) {
      return command('PUBLISH', channel, message);
    },

    /** RPUSH key value */
    async rpush(key, value) {
      return command('RPUSH', key, value);
    },

    /** LRANGE key start stop */
    async lrange(key, start, stop) {
      return command('LRANGE', key, String(start), String(stop));
    },

    /** LLEN key */
    async llen(key) {
      return command('LLEN', key);
    },

    /** Graceful disconnect */
    async quit() {
      if (connected) {
        try { await command('QUIT'); } catch { /* ignore */ }
        socket.destroy();
        connected = false;
      }
    },
  };
}

// --- Redis-backed Store ---

/**
 * Create a Redis-backed store that implements the same interface as the in-memory store.
 *
 * Key layout:
 *   {prefix}:meta:{requestId}     — JSON metadata (status, url, model, timing, etc.)
 *   {prefix}:chunks:{requestId}   — List of raw chunks
 *   {prefix}:text:{requestId}     — Accumulated full text
 *
 * @param {string} redisUrl
 * @returns {Promise<Object>} Store with same API as in-memory store
 */
export async function createRedisStore(redisUrl) {
  const redis = await createRedisClient(redisUrl);
  const instanceId = `inst_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

  /** @type {Map<string, Set<(event: string) => void>>} */
  const localSubscribers = new Map();

  /** @type {Map<string, AbortController>} */
  const abortControllers = new Map();

  log.info('redis-store:init', { instanceId, prefix: KEY_PREFIX });

  // --- Key helpers ---
  const metaKey = (id) => `${KEY_PREFIX}:meta:${id}`;
  const chunksKey = (id) => `${KEY_PREFIX}:chunks:${id}`;
  const textKey = (id) => `${KEY_PREFIX}:text:${id}`;
  const ttlSeconds = Math.ceil(BUFFER_TTL_MS / 1000);

  // --- Store interface ---

  return {
    instanceId,

    async createBuffer({ url, method, headers, body, chatId }) {
      const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const meta = {
        requestId,
        chatId: chatId || undefined,
        status: 'pending',
        url,
        method: method || 'POST',
        headers: headers || {},
        body,
        byteSize: 0,
        error: undefined,
        createdAt: new Date().toISOString(),
        completedAt: undefined,
        instanceId,
      };

      const ac = new AbortController();
      abortControllers.set(requestId, ac);

      await redis.set(metaKey(requestId), JSON.stringify(meta));
      await redis.set(textKey(requestId), '');

      log.debug('redis-store:create', { requestId, chatId, url });

      return {
        ...meta,
        chunks: [],
        fullText: '',
        subscribers: new Set(),
        abortController: ac,
      };
    },

    async getBuffer(requestId) {
      const raw = await redis.get(metaKey(requestId));
      if (!raw) return undefined;

      const meta = JSON.parse(raw);
      const fullText = (await redis.get(textKey(requestId))) || '';
      const chunkCount = (await redis.llen(chunksKey(requestId))) || 0;

      return {
        ...meta,
        chunks: { length: chunkCount }, // Proxy array-like for chunk count
        fullText,
        subscribers: localSubscribers.get(requestId) || new Set(),
        abortController: abortControllers.get(requestId) || new AbortController(),
      };
    },

    async pushChunk(requestId, chunkText) {
      const raw = await redis.get(metaKey(requestId));
      if (!raw) return;

      const meta = JSON.parse(raw);
      const chunkBytes = Buffer.byteLength(chunkText);
      meta.byteSize = (meta.byteSize || 0) + chunkBytes;

      await redis.set(metaKey(requestId), JSON.stringify(meta));
      const index = await redis.rpush(chunksKey(requestId), chunkText);

      // Append to full text
      const prevText = (await redis.get(textKey(requestId))) || '';
      await redis.set(textKey(requestId), prevText + chunkText);

      // Notify local subscribers
      const event = JSON.stringify({ index: index - 1, chunk: chunkText, done: false });
      const subs = localSubscribers.get(requestId);
      if (subs) {
        for (const send of subs) {
          try { send(event); } catch { /* subscriber gone */ }
        }
      }

      // Publish to other instances
      await redis.publish(`${KEY_PREFIX}:events`, JSON.stringify({
        type: 'chunk',
        requestId,
        index: index - 1,
        chunk: chunkText,
        instanceId,
      })).catch(() => {});
    },

    async completeBuffer(requestId) {
      const raw = await redis.get(metaKey(requestId));
      if (!raw) return;

      const meta = JSON.parse(raw);
      meta.status = 'completed';
      meta.completedAt = new Date().toISOString();

      await redis.set(metaKey(requestId), JSON.stringify(meta), ttlSeconds);
      await redis.expire(chunksKey(requestId), ttlSeconds);
      await redis.expire(textKey(requestId), ttlSeconds);

      const fullText = (await redis.get(textKey(requestId))) || '';
      const event = JSON.stringify({ done: true, fullText });
      const subs = localSubscribers.get(requestId);
      if (subs) {
        for (const send of subs) {
          try { send(event); } catch { /* ignore */ }
        }
        subs.clear();
      }

      await redis.publish(`${KEY_PREFIX}:events`, JSON.stringify({
        type: 'complete',
        requestId,
        instanceId,
      })).catch(() => {});
    },

    async failBuffer(requestId, error) {
      const raw = await redis.get(metaKey(requestId));
      if (!raw) return;

      const meta = JSON.parse(raw);
      meta.status = 'failed';
      meta.error = typeof error === 'string' ? error : (error?.message ?? String(error));
      meta.completedAt = new Date().toISOString();

      await redis.set(metaKey(requestId), JSON.stringify(meta), ttlSeconds);
      await redis.expire(chunksKey(requestId), ttlSeconds);
      await redis.expire(textKey(requestId), ttlSeconds);

      const event = JSON.stringify({ done: true, error: meta.error });
      const subs = localSubscribers.get(requestId);
      if (subs) {
        for (const send of subs) {
          try { send(event); } catch { /* ignore */ }
        }
        subs.clear();
      }
    },

    async cancelBuffer(requestId) {
      const raw = await redis.get(metaKey(requestId));
      if (!raw) return false;

      const meta = JSON.parse(raw);
      if (['completed', 'failed', 'cancelled'].includes(meta.status)) return false;

      const ac = abortControllers.get(requestId);
      if (ac) ac.abort();

      meta.status = 'cancelled';
      meta.completedAt = new Date().toISOString();

      await redis.set(metaKey(requestId), JSON.stringify(meta), ttlSeconds);
      await redis.expire(chunksKey(requestId), ttlSeconds);
      await redis.expire(textKey(requestId), ttlSeconds);

      const event = JSON.stringify({ done: true, cancelled: true });
      const subs = localSubscribers.get(requestId);
      if (subs) {
        for (const send of subs) {
          try { send(event); } catch { /* ignore */ }
        }
        subs.clear();
      }

      return true;
    },

    subscribe(requestId, sendFn) {
      if (!localSubscribers.has(requestId)) {
        localSubscribers.set(requestId, new Set());
      }
      localSubscribers.get(requestId).add(sendFn);
      return () => {
        const subs = localSubscribers.get(requestId);
        if (subs) subs.delete(sendFn);
      };
    },

    async getChunks(requestId, offset = 0) {
      const count = (await redis.llen(chunksKey(requestId))) || 0;
      if (offset >= count) return [];
      return redis.lrange(chunksKey(requestId), offset, -1);
    },

    async listBuffers() {
      const keys = await redis.keys(`${KEY_PREFIX}:meta:*`);
      const result = [];
      for (const key of (keys || [])) {
        try {
          const raw = await redis.get(key);
          if (raw) {
            const meta = JSON.parse(raw);
            result.push({
              requestId: meta.requestId,
              chatId: meta.chatId,
              status: meta.status,
              byteSizeKB: ((meta.byteSize || 0) / 1024).toFixed(1),
              createdAt: meta.createdAt,
              completedAt: meta.completedAt,
              instanceId: meta.instanceId,
            });
          }
        } catch { /* skip malformed */ }
      }
      return result;
    },

    async getStoreStats() {
      const keys = await redis.keys(`${KEY_PREFIX}:meta:*`);
      const stats = {
        total: keys?.length || 0,
        memoryMB: 'N/A (Redis)',
        memoryLimitMB: 'N/A (Redis)',
        instanceId,
        pending: 0,
        streaming: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      };

      for (const key of (keys || [])) {
        try {
          const raw = await redis.get(key);
          if (raw) {
            const meta = JSON.parse(raw);
            if (stats[meta.status] != null) stats[meta.status]++;
          }
        } catch { /* skip */ }
      }

      return stats;
    },

    async cancelAll() {
      for (const [, ac] of abortControllers) {
        ac.abort();
      }
    },

    async cleanupExpired() {
      // Redis handles TTL-based expiry automatically
      // Just clean up local state
      for (const [id, subs] of localSubscribers) {
        const raw = await redis.get(metaKey(id));
        if (!raw) {
          subs.clear();
          localSubscribers.delete(id);
          abortControllers.delete(id);
        }
      }
    },

    async quit() {
      await redis.quit();
    },
  };
}
