const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = LEVELS[LOG_LEVEL] ?? 1;

const MAX_LOG_ENTRIES = 500;
const logBuffer = [];

function ts() {
  return new Date().toISOString();
}

function fmt(level, msg, data) {
  const base = `${ts()} [${level.toUpperCase()}] ${msg}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}

function pushLog(level, msg, data) {
  const entry = { ts: ts(), level, msg, data: data || null };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }
}

export function debug(msg, data) {
  pushLog('debug', msg, data);
  if (threshold <= 0) console.debug(fmt('debug', msg, data));
}

export function info(msg, data) {
  pushLog('info', msg, data);
  if (threshold <= 1) console.log(fmt('info', msg, data));
}

export function warn(msg, data) {
  pushLog('warn', msg, data);
  if (threshold <= 2) console.warn(fmt('warn', msg, data));
}

export function error(msg, data) {
  pushLog('error', msg, data);
  if (threshold <= 3) console.error(fmt('error', msg, data));
}

/** Get recent log entries. Options: { level, limit } */
export function getRecentLogs({ level, limit = 200 } = {}) {
  let logs = logBuffer;
  if (level) {
    logs = logs.filter(e => e.level === level);
  }
  return logs.slice(-limit);
}
