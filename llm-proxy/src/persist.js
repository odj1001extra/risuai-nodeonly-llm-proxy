/**
 * File-based persistence for cost data across Docker restarts.
 *
 * Saves aggregate cost stats + per-request cost records to a JSON file
 * in the DATA_DIR volume mount. Loaded on startup, saved periodically
 * and on shutdown.
 *
 * Configuration:
 *   DATA_DIR — Directory for persistent files (default: /app/data)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import * as log from './logger.js';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const COST_FILE = resolve(DATA_DIR, 'cost-data.json');
const REQUEST_LOG_FILE = resolve(DATA_DIR, 'request-log.json');

/**
 * Load persisted cost data from disk.
 * @returns {{ aggregate: Object, costs: Array }|null}
 */
export function loadCostData() {
  try {
    if (!existsSync(COST_FILE)) return null;
    const raw = readFileSync(COST_FILE, 'utf-8');
    const data = JSON.parse(raw);
    log.info('persist:loaded', {
      file: COST_FILE,
      requests: data.costs?.length ?? 0,
      totalCost: data.aggregate?.totalCost ?? 0,
    });
    return data;
  } catch (e) {
    log.warn('persist:load-error', { file: COST_FILE, error: e.message });
    return null;
  }
}

/**
 * Save cost data to disk.
 * @param {{ aggregate: Object, costs: Array }} data
 */
export function saveCostData(data) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(COST_FILE, JSON.stringify(data, null, 2));
    log.debug('persist:saved', { file: COST_FILE, requests: data.costs?.length ?? 0 });
  } catch (e) {
    log.warn('persist:save-error', { file: COST_FILE, error: e.message });
  }
}

/**
 * Delete persisted cost data file.
 */
export function resetCostFile() {
  try {
    if (existsSync(COST_FILE)) {
      unlinkSync(COST_FILE);
      log.info('persist:reset', { file: COST_FILE });
    }
  } catch (e) {
    log.warn('persist:reset-error', { file: COST_FILE, error: e.message });
  }
}

// --- Request log persistence ---

/**
 * Load persisted request log from disk.
 * @returns {Array|null}
 */
export function loadRequestLog() {
  try {
    if (!existsSync(REQUEST_LOG_FILE)) return null;
    const raw = readFileSync(REQUEST_LOG_FILE, 'utf-8');
    const data = JSON.parse(raw);
    log.info('persist:log-loaded', {
      file: REQUEST_LOG_FILE,
      entries: Array.isArray(data) ? data.length : 0,
    });
    return Array.isArray(data) ? data : null;
  } catch (e) {
    log.warn('persist:log-load-error', { file: REQUEST_LOG_FILE, error: e.message });
    return null;
  }
}

/**
 * Save request log to disk.
 * @param {Array} entries
 */
export function saveRequestLog(entries) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REQUEST_LOG_FILE, JSON.stringify(entries, null, 2));
    log.debug('persist:log-saved', { file: REQUEST_LOG_FILE, entries: entries.length });
  } catch (e) {
    log.warn('persist:log-save-error', { file: REQUEST_LOG_FILE, error: e.message });
  }
}

/**
 * Delete persisted request log file.
 */
export function resetRequestLogFile() {
  try {
    if (existsSync(REQUEST_LOG_FILE)) {
      unlinkSync(REQUEST_LOG_FILE);
      log.info('persist:log-reset', { file: REQUEST_LOG_FILE });
    }
  } catch (e) {
    log.warn('persist:log-reset-error', { file: REQUEST_LOG_FILE, error: e.message });
  }
}
