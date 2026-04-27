/**
 * LLM Response Proxy — Browser Injection Script
 *
 * Sets window.userScriptFetch to route LLM streaming requests through
 * the proxy service for tab-safe response buffering.
 *
 * Injection: Docker entrypoint adds <script src="/proxy-inject.js"> to index.html.
 * RisuAI checks window.userScriptFetch FIRST in both globalFetch() and fetchNative(),
 * so this takes priority over all other fetch paths.
 *
 * Behavior:
 *   - ALL requests → LLM proxy (buffered, reconnectable, tab-switch safe)
 *     Streaming detection: body.stream === true (OpenAI/Anthropic)
 *                          OR URL contains streamGenerateContent (Google Gemini)
 *     Streaming → returns Response with self-healing ReadableStream
 *     Non-streaming → collects response, returns complete Response with upstream status/headers
 *   - Fallback → /proxy2 (RisuAI's existing same-origin CORS proxy) when proxy unavailable
 *
 * Tab recovery:
 *   When the user leaves the tab, the proxy server continues buffering LLM responses.
 *   On tab return, the script detects visibilitychange, aborts the stale SSE connection,
 *   and reconnects with ?offset=N to resume from where it left off. The ReadableStream
 *   handed to RisuAI is self-healing — reconnection is transparent to the consumer.
 */
(function () {
  'use strict';

  // --- Configuration ---

  var PROXY_PORT = window.__LLM_PROXY_PORT__ || '6100';
  var PROXY_URL = window.__LLM_PROXY_URL__ ||
    (location.protocol + '//' + location.hostname + ':' + PROXY_PORT);
  var PROXY_AUTH_KEY = window.__LLM_PROXY_AUTH_KEY__ || '';

  var MAX_RECONNECT_ATTEMPTS = 10;
  var COLLECT_TIMEOUT_MS = 15 * 60 * 1000; // 15 min safety timeout (matches relay timeout)

  // Generate a per-tab session ID for chatId grouping
  var SESSION_ID = (function () {
    var key = '__llm_proxy_session_id';
    var id = sessionStorage.getItem(key);
    if (!id) {
      id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      sessionStorage.setItem(key, id);
    }
    return id;
  })();

  console.log('[LLM Proxy] Injection active, proxy URL:', PROXY_URL, '| session:', SESSION_ID);

  // --- Special Day Override ---

  /**
   * Patch Date so RisuAI sees a different date during app initialization.
   * This controls the special day decorations (April Fools overlay, Christmas hat, etc.)
   *
   * localStorage 'llm-proxy-special-day':
   *   'none'        — default behavior (actual date)
   *   'disabled'    — suppress all special days (pretend it's a normal day)
   *   'christmas'   — Dec 25
   *   'newYear'     — Jan 1
   *   'aprilFool'   — Apr 1
   *   'anniversary' — Apr 13
   *   'halloween'   — Oct 31
   *   'chuseok'     — Sep 16
   */
  var SPECIAL_DAY_DATES = {
    christmas:   { month: 11, date: 25 },
    newYear:     { month: 0,  date: 1  },
    aprilFool:   { month: 3,  date: 1  },
    anniversary: { month: 3,  date: 13 },
    halloween:   { month: 9,  date: 31 },
    chuseok:     { month: 8,  date: 16 }
  };

  (function patchSpecialDay() {
    var setting = '';
    try { setting = localStorage.getItem('llm-proxy-special-day') || ''; } catch (e) {}
    if (!setting || setting === 'none') return;

    var _OrigDate = Date;
    var target = SPECIAL_DAY_DATES[setting]; // null if 'disabled'

    function PatchedDate() {
      var d = arguments.length === 0
        ? new _OrigDate()
        : new (Function.prototype.bind.apply(_OrigDate, [null].concat(Array.prototype.slice.call(arguments))))();

      // Only patch no-arg calls (i.e. "current date" checks)
      if (arguments.length === 0) {
        if (setting === 'disabled') {
          // Force a date that matches no special day
          d.setMonth(5); d.setDate(15); // Jun 15
        } else if (target) {
          d.setMonth(target.month);
          d.setDate(target.date);
        }
      }
      return d;
    }

    PatchedDate.prototype = _OrigDate.prototype;
    PatchedDate.now = function () { return _OrigDate.now(); };
    PatchedDate.parse = function (s) { return _OrigDate.parse(s); };
    PatchedDate.UTC = function () { return _OrigDate.UTC.apply(_OrigDate, arguments); };
    window.Date = PatchedDate;

    console.log('[LLM Proxy] Special day override:', setting);

    // Restore after app initialization (3s is enough for Svelte mount)
    setTimeout(function () {
      window.Date = _OrigDate;
      console.log('[LLM Proxy] Date restored to original');
    }, 3000);
  })();

  // --- Browser notification ---

  /**
   * Show a browser notification when LLM response completes,
   * but only if the tab is hidden and notifications are enabled.
   * Toggle is controlled via localStorage from the admin dashboard.
   */
  function notifyCompletion(requestId, isError) {
    try {
      if (document.visibilityState !== 'hidden') return;
      if (localStorage.getItem('llm-proxy-notify') !== 'true') return;
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'granted') return;

      var title = isError ? 'LLM 응답 실패' : 'LLM 응답 완료';
      var body = requestId.slice(0, 16);
      var n = new Notification(title, {
        body: body,
        tag: 'llm-proxy-' + requestId,
        silent: false,
      });
      setTimeout(function () { n.close(); }, 8000);
    } catch (e) { /* notification failed, ignore */ }
  }

  // --- Active request tracking ---

  /** @type {Map<string, { offset: number, type: 'stream'|'relay' }>} */
  var activeRequests = new Map();

  /** @type {Map<string, AbortController>} */
  var streamAbortControllers = new Map();

  // --- sessionStorage persistence ---

  function persistActiveRequest(requestId, offset) {
    try {
      var data = JSON.parse(sessionStorage.getItem('__llm_proxy_active') || '{}');
      data[requestId] = { offset: offset, ts: Date.now() };
      sessionStorage.setItem('__llm_proxy_active', JSON.stringify(data));
    } catch (e) { /* sessionStorage unavailable */ }
  }

  function removePersistedRequest(requestId) {
    try {
      var data = JSON.parse(sessionStorage.getItem('__llm_proxy_active') || '{}');
      delete data[requestId];
      sessionStorage.setItem('__llm_proxy_active', JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  // --- Tab visibility handler ---

  var lastHiddenAt = 0;
  var MIN_HIDDEN_MS = 2000; // Only force-reconnect if hidden for 2s+

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      lastHiddenAt = Date.now();
      return;
    }

    // Tab became visible
    if (activeRequests.size === 0) return;

    var hiddenDuration = lastHiddenAt > 0 ? Date.now() - lastHiddenAt : 0;
    if (hiddenDuration < MIN_HIDDEN_MS) {
      console.log('[LLM Proxy] Tab visible after', hiddenDuration + 'ms (< ' + MIN_HIDDEN_MS + 'ms), skipping reconnect');
      return;
    }

    // Force-reconnect ALL active requests (streaming and non-streaming).
    // Mobile browsers kill SSE connections when backgrounded, so both types
    // need reconnection on tab return.
    var reconnectCount = 0;
    streamAbortControllers.forEach(function (ac, requestId) {
      reconnectCount++;
      ac.abort();
    });

    if (reconnectCount > 0) {
      console.log('[LLM Proxy] Tab visible after', hiddenDuration + 'ms, forcing reconnect for',
        reconnectCount, 'request(s)');
    }
  });

  // --- Helpers ---

  /**
   * Combine two AbortSignals into one.
   * Needed because AbortSignal.any() is not available in all browsers.
   */
  function combineSignals(a, b) {
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([a, b]);
    }
    var combined = new AbortController();
    function onAbort() { combined.abort(); }
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
    return combined.signal;
  }

  /**
   * Build headers for requests to the proxy server.
   * @returns {Object}
   */
  function proxyHeaders() {
    var h = { 'Content-Type': 'application/json' };
    if (PROXY_AUTH_KEY) {
      h['x-proxy-auth'] = PROXY_AUTH_KEY;
    }
    return h;
  }

  /**
   * Try to parse request body as JSON object.
   * Handles Uint8Array, ArrayBuffer, string, and plain objects.
   * @param {Uint8Array|ArrayBuffer|string|undefined} body
   * @returns {{ obj: Object|null, raw: string|null }}
   */
  function parseBody(body) {
    try {
      if (body instanceof ArrayBuffer) {
        var text = new TextDecoder().decode(new Uint8Array(body));
        try { return { obj: JSON.parse(text), raw: text }; }
        catch (e) { return { obj: null, raw: text }; }
      }
      if (body instanceof Uint8Array) {
        var text = new TextDecoder().decode(body);
        try { return { obj: JSON.parse(text), raw: text }; }
        catch (e) { return { obj: null, raw: text }; }
      }
      if (typeof body === 'string') {
        try { return { obj: JSON.parse(body), raw: body }; }
        catch (e) { return { obj: null, raw: body }; }
      }
      if (body && typeof body === 'object') {
        return { obj: body, raw: JSON.stringify(body) };
      }
    } catch (e) {
      // Decoding failed entirely
    }
    return { obj: null, raw: null };
  }

  /**
   * Detect streaming requests using both body content and URL patterns.
   *
   * Different LLM providers signal streaming differently:
   *   - OpenAI / Anthropic: body contains { stream: true }
   *   - Google Gemini: URL endpoint is streamGenerateContent (no stream in body)
   *
   * @param {string} url
   * @param {Object|null} bodyObj  Parsed JSON body
   * @returns {boolean}
   */
  function isStreamingRequest(url, bodyObj) {
    // 1. Body-based: OpenAI, Anthropic, and other OpenAI-compatible APIs
    if (bodyObj && bodyObj.stream === true) return true;

    // 2. URL-based: Google Gemini streaming endpoint
    if (url && /[:\/]streamGenerateContent[?\s]/.test(url + ' ')) return true;

    return false;
  }

  /**
   * Convert Headers object / array tuples to a plain object.
   * Needed because JSON.stringify(Headers) produces "{}".
   * @param {Headers|Object|Array} h
   * @returns {Object}
   */
  function headersToPlain(h) {
    if (!h) return {};
    if (h instanceof Headers) {
      var obj = {};
      h.forEach(function (value, key) { obj[key] = value; });
      return obj;
    }
    if (Array.isArray(h)) {
      var obj = {};
      for (var i = 0; i < h.length; i++) {
        if (Array.isArray(h[i]) && h[i].length >= 2) {
          obj[h[i][0]] = h[i][1];
        }
      }
      return obj;
    }
    return h;
  }

  // --- Self-Healing ReadableStream ---

  /**
   * Create a ReadableStream that transparently reconnects to the proxy SSE
   * endpoint when the connection drops (e.g., tab switch).
   *
   * The stream internally manages:
   * - SSE parsing (data: JSON lines → raw LLM bytes)
   * - Chunk offset tracking for reconnection
   * - visibilitychange-driven abort + reconnect
   * - Exponential backoff on repeated failures
   *
   * @param {string} requestId
   * @param {AbortSignal|null} userSignal  RisuAI's abort signal (stop button)
   * @returns {ReadableStream<Uint8Array>}
   */
  function createResilientStream(requestId, userSignal) {
    var offset = 0;
    var cancelled = false;
    var sseBuffer = '';
    var reconnectAttempts = 0;
    var encoder = new TextEncoder();

    activeRequests.set(requestId, { offset: 0, type: 'stream' });

    return new ReadableStream({
      start: function (controller) {
        // Wire up user abort (RisuAI stop button)
        if (userSignal) {
          userSignal.addEventListener('abort', function () {
            cancelled = true;
            cleanup(requestId);
            try { controller.close(); } catch (e) { /* already closed */ }
          }, { once: true });
        }

        connectAndPull(requestId, controller);
      },

      cancel: function () {
        cancelled = true;
        cleanup(requestId);
      }
    });

    function cleanup(reqId) {
      activeRequests.delete(reqId);
      var ac = streamAbortControllers.get(reqId);
      if (ac) {
        ac.abort();
        streamAbortControllers.delete(reqId);
      }
      removePersistedRequest(reqId);
    }

    function connectAndPull(reqId, controller) {
      if (cancelled) return;

      // Create a per-connection AbortController
      var connectionAC = new AbortController();
      streamAbortControllers.set(reqId, connectionAC);

      var fetchSignal = userSignal
        ? combineSignals(userSignal, connectionAC.signal)
        : connectionAC.signal;

      var streamUrl = PROXY_URL + '/stream/' + reqId +
        (offset > 0 ? '?offset=' + offset : '');

      console.log('[LLM Proxy] Connecting to stream:', streamUrl);

      var headers = {};
      if (PROXY_AUTH_KEY) {
        headers['x-proxy-auth'] = PROXY_AUTH_KEY;
      }

      fetch(streamUrl, { signal: fetchSignal, headers: headers })
        .then(function (sseRes) {
          if (!sseRes.ok) {
            throw new Error('Stream HTTP ' + sseRes.status);
          }
          // Reset reconnect counter on successful connection
          reconnectAttempts = 0;
          var reader = sseRes.body.getReader();
          var decoder = new TextDecoder();
          return readLoop(reader, decoder, reqId, controller);
        })
        .catch(function (err) {
          streamAbortControllers.delete(reqId);
          if (cancelled) return;
          if (userSignal && userSignal.aborted) return;

          console.warn('[LLM Proxy] Stream connection error:', err.message);
          scheduleReconnect(reqId, controller);
        });
    }

    function readLoop(reader, decoder, reqId, controller) {
      if (cancelled) return Promise.resolve();

      return reader.read().then(function (result) {
        if (result.done) {
          // SSE connection closed cleanly — process remaining buffer
          processSSEBuffer(controller, true, reqId);
          return;
        }

        var text = decoder.decode(result.value, { stream: true });
        sseBuffer += text;
        processSSEBuffer(controller, false, reqId);

        return readLoop(reader, decoder, reqId, controller);
      }).catch(function (err) {
        streamAbortControllers.delete(reqId);
        if (cancelled) return;
        if (userSignal && userSignal.aborted) return;

        console.warn('[LLM Proxy] Stream read error:', err.message);
        scheduleReconnect(reqId, controller);
      });
    }

    function processSSEBuffer(controller, isFinal, reqId) {
      var parts = sseBuffer.split('\n');
      if (!isFinal) {
        sseBuffer = parts.pop() || '';
      } else {
        sseBuffer = '';
      }

      for (var i = 0; i < parts.length; i++) {
        var line = parts[i];
        if (!line.startsWith('data: ')) continue;
        var raw = line.slice(6);
        try {
          var parsed = JSON.parse(raw);
          if (parsed.done) {
            // Stream complete
            if (parsed.error) {
              console.error('[LLM Proxy] Stream relay error:', parsed.error);
              // Deliver error body as final chunk (separated from normal chunks by #5 fix)
              if (parsed.errorBody) {
                try { controller.enqueue(encoder.encode(parsed.errorBody)); } catch (e) { /* closed */ }
              }
            }
            notifyCompletion(reqId, !!parsed.error);
            cancelled = true;
            cleanup(reqId);
            try { controller.close(); } catch (e) { /* already closed */ }
            return;
          }
          if (parsed.chunk != null) {
            var encoded = encoder.encode(parsed.chunk);
            try { controller.enqueue(encoded); } catch (e) { /* stream closed */ }
            offset = parsed.index + 1;
            // Update tracking
            var entry = activeRequests.get(reqId);
            if (entry) entry.offset = offset;
            persistActiveRequest(reqId, offset);
          }
        } catch (e) {
          // Not valid JSON (keepalive comment, etc.) — skip
        }
      }
    }

    function scheduleReconnect(reqId, controller) {
      if (cancelled) return;

      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[LLM Proxy] Max reconnection attempts reached for:', reqId);
        cleanup(reqId);
        try {
          controller.error(new Error('Max reconnection attempts exceeded'));
        } catch (e) { /* already errored/closed */ }
        return;
      }

      reconnectAttempts++;
      var delay = document.visibilityState === 'visible'
        ? 0
        : Math.min(500 * Math.pow(2, reconnectAttempts - 1), 10000);

      // Check if the request still exists on the server
      var statusHeaders = {};
      if (PROXY_AUTH_KEY) statusHeaders['x-proxy-auth'] = PROXY_AUTH_KEY;

      fetch(PROXY_URL + '/status/' + reqId, { headers: statusHeaders })
        .then(function (res) {
          if (cancelled) return;

          if (res.status === 404) {
            console.error('[LLM Proxy] Buffer expired (TTL), cannot recover:', reqId);
            cleanup(reqId);
            try {
              controller.error(new Error('Proxy buffer expired'));
            } catch (e) { /* already errored/closed */ }
            return;
          }

          return res.json().then(function (status) {
            if (cancelled) return;

            if (status.status === 'cancelled') {
              cleanup(reqId);
              try { controller.close(); } catch (e) { /* already closed */ }
              return;
            }

            console.log('[LLM Proxy] Reconnecting in ' + delay + 'ms' +
              ' (offset=' + offset + ', server chunks=' + status.chunksReceived + ')');

            setTimeout(function () {
              if (!cancelled) {
                sseBuffer = '';
                connectAndPull(reqId, controller);
              }
            }, delay);
          });
        })
        .catch(function (err) {
          if (cancelled) return;
          // Status check also failed — proxy may be down, retry with backoff
          console.warn('[LLM Proxy] Status check failed, retrying in ' + delay + 'ms:', err.message);
          setTimeout(function () {
            if (!cancelled) scheduleReconnect(reqId, controller);
          }, delay);
        });
    }
  }

  // --- Fast failure detection ---

  /**
   * Wait briefly and check if the upstream request already failed.
   * Returns an error Response if failed, null otherwise.
   *
   * This catches fast failures (401 auth, 403 forbidden, invalid URL)
   * that resolve before the client starts reading the SSE stream,
   * allowing streamViaProxy to return a proper error status instead of 200.
   *
   * @param {string} requestId
   * @param {AbortSignal|null} userSignal
   * @returns {Promise<Response|null>}
   */
  async function checkFastFailure(requestId, userSignal) {
    await new Promise(function (r) { setTimeout(r, 200); });
    if (userSignal && userSignal.aborted) return null;

    try {
      var statusHeaders = {};
      if (PROXY_AUTH_KEY) statusHeaders['x-proxy-auth'] = PROXY_AUTH_KEY;
      var res = await fetch(PROXY_URL + '/status/' + requestId, { headers: statusHeaders });
      if (!res.ok) return null;
      var data = await res.json();

      if (data.status === 'failed') {
        // Collect the done event from SSE to get errorBody and upstream metadata
        var streamHeaders = {};
        if (PROXY_AUTH_KEY) streamHeaders['x-proxy-auth'] = PROXY_AUTH_KEY;
        var sseRes = await fetch(PROXY_URL + '/stream/' + requestId, { headers: streamHeaders });
        var sseText = await sseRes.text();
        var lines = sseText.split('\n');
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i].startsWith('data: ')) continue;
          try {
            var parsed = JSON.parse(lines[i].slice(6));
            if (parsed.done && parsed.error) {
              var status = parsed.upstreamStatus || 502;
              var body = parsed.errorBody || parsed.error;
              console.warn('[LLM Proxy] Fast failure detected:', status, parsed.error);
              var failStream = new ReadableStream({
                start: function(c) {
                  c.enqueue(new TextEncoder().encode(body));
                  c.close();
                }
              });
              return new Response(failStream, {
                status: status,
                headers: filterHeaders(parsed.upstreamHeaders),
              });
            }
          } catch (e) { /* skip */ }
        }
      }
    } catch (e) {
      // Status check failed — proceed with streaming (will reconnect if needed)
    }
    return null;
  }

  // --- Streaming path (via LLM proxy) ---

  /**
   * Route a streaming request through the LLM proxy.
   * Returns a Response with a self-healing ReadableStream body.
   * @param {string} url       Target LLM API URL
   * @param {Object} options   fetch-like options
   * @param {Object|null} bodyObj   Parsed JSON body (null for URL-detected streaming)
   * @returns {Promise<Response>}
   */
  async function streamViaProxy(url, options, bodyObj, rawBody) {
    // 1. Submit to proxy
    var submitBody = {
      url: url,
      method: options.method || 'POST',
      headers: headersToPlain(options.headers),
      body: bodyObj,
      rawBody: bodyObj == null ? rawBody : undefined,
      chatId: SESSION_ID,
    };

    console.log('[LLM Proxy] Submitting to proxy:', PROXY_URL + '/request',
      '| target:', url, '| bodyKeys:', bodyObj ? Object.keys(bodyObj).join(',') : 'null');

    var submitRes = await fetch(PROXY_URL + '/request', {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify(submitBody),
    });

    if (!submitRes.ok) {
      var errText = await submitRes.text();
      throw new Error('HTTP ' + submitRes.status + ': ' + errText);
    }

    var data = await submitRes.json();
    var requestId = data.requestId;

    console.log('[LLM Proxy] Request submitted:', requestId);

    // 2. Wire abort signal → cancel on proxy
    if (options.signal) {
      options.signal.addEventListener('abort', function () {
        var cancelHeaders = {};
        if (PROXY_AUTH_KEY) cancelHeaders['x-proxy-auth'] = PROXY_AUTH_KEY;
        fetch(PROXY_URL + '/cancel/' + requestId, {
          method: 'POST',
          headers: cancelHeaders,
        }).catch(function () {});
      }, { once: true });
    }

    // 3. Quick-check for fast upstream failures (auth errors, bad URL, etc.)
    //    Wait briefly then poll status. If already failed, return error Response
    //    instead of a streaming 200 that would confuse RisuAI.
    var fastFail = await checkFastFailure(requestId, options.signal);
    if (fastFail) return fastFail;

    // 4. Create self-healing stream
    var resilientBody = createResilientStream(requestId, options.signal || null);

    return new Response(resilientBody, {
      status: 200,
      headers: new Headers({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }),
    });
  }

  // --- Non-streaming path (via LLM proxy, with reconnection) ---

  /**
   * Route a non-streaming request through the LLM proxy.
   * Collects the complete response (with reconnection support for tab-switch
   * survival), then returns a proper Response with upstream status/headers.
   *
   * @param {string} url       Target LLM API URL
   * @param {Object} options   fetch-like options
   * @param {Object|null} bodyObj   Parsed JSON body
   * @returns {Promise<Response>}
   */
  async function relayViaProxy(url, options, bodyObj, rawBody) {
    // 1. Submit to proxy
    var submitBody = {
      url: url,
      method: options.method || 'POST',
      headers: headersToPlain(options.headers),
      body: bodyObj,
      rawBody: bodyObj == null ? rawBody : undefined,
      chatId: SESSION_ID,
    };

    console.log('[LLM Proxy] Relaying via proxy:', PROXY_URL + '/request',
      '| target:', url.replace(/[?&]key=[^&]+/g, '?key=<hidden>'));

    var submitRes = await fetch(PROXY_URL + '/request', {
      method: 'POST',
      headers: proxyHeaders(),
      body: JSON.stringify(submitBody),
    });

    if (!submitRes.ok) {
      var errText = await submitRes.text();
      throw new Error('HTTP ' + submitRes.status + ': ' + errText);
    }

    var data = await submitRes.json();
    var requestId = data.requestId;

    console.log('[LLM Proxy] Relay submitted:', requestId);

    // 2. Wire abort signal → cancel on proxy
    if (options.signal) {
      options.signal.addEventListener('abort', function () {
        var cancelHeaders = {};
        if (PROXY_AUTH_KEY) cancelHeaders['x-proxy-auth'] = PROXY_AUTH_KEY;
        fetch(PROXY_URL + '/cancel/' + requestId, {
          method: 'POST',
          headers: cancelHeaders,
        }).catch(function () {});
      }, { once: true });
    }

    // 3. Collect complete response via SSE (with reconnection)
    var response = await collectResponse(requestId, options.signal || null);
    console.log('[LLM Proxy] relayViaProxy resolved:', requestId,
      '| ok:', response.ok, '| status:', response.status,
      '| type:', response.headers.get('content-type'));
    return response;
  }

  /**
   * Collect all SSE chunks for a non-streaming request and return a
   * complete Response with upstream status/headers. Supports reconnection
   * for tab-switch survival.
   *
   * @param {string} requestId
   * @param {AbortSignal|null} userSignal
   * @returns {Promise<Response>}
   */
  function collectResponse(requestId, userSignal) {
    return new Promise(function (resolve, reject) {
      var chunks = [];
      var offset = 0;
      var cancelled = false;
      var reconnectAttempts = 0;
      var sseBuffer = '';
      var settled = false;

      activeRequests.set(requestId, { offset: 0, type: 'relay' });

      // Safety timeout to prevent infinite hangs
      var safetyTimer = setTimeout(function () {
        if (!settled) {
          console.error('[LLM Proxy] collectResponse TIMEOUT after ' +
            (COLLECT_TIMEOUT_MS / 1000) + 's for:', requestId,
            '| chunks:', chunks.length, '| offset:', offset);
          cancelled = true;
          cleanup();
          reject(new Error('Proxy collectResponse timed out after ' +
            (COLLECT_TIMEOUT_MS / 1000) + 's'));
        }
      }, COLLECT_TIMEOUT_MS);

      function settledResolve(value) {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        resolve(value);
      }

      function settledReject(reason) {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        reject(reason);
      }

      if (userSignal) {
        userSignal.addEventListener('abort', function () {
          cancelled = true;
          cleanup();
          settledReject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      }

      function cleanup() {
        activeRequests.delete(requestId);
        var ac = streamAbortControllers.get(requestId);
        if (ac) {
          ac.abort();
          streamAbortControllers.delete(requestId);
        }
        removePersistedRequest(requestId);
      }

      function connect() {
        if (cancelled) return;

        var connectionAC = new AbortController();
        streamAbortControllers.set(requestId, connectionAC);

        var fetchSignal = userSignal
          ? combineSignals(userSignal, connectionAC.signal)
          : connectionAC.signal;

        var streamUrl = PROXY_URL + '/stream/' + requestId +
          (offset > 0 ? '?offset=' + offset : '');

        var headers = {};
        if (PROXY_AUTH_KEY) headers['x-proxy-auth'] = PROXY_AUTH_KEY;

        fetch(streamUrl, { signal: fetchSignal, headers: headers })
          .then(function (sseRes) {
            if (!sseRes.ok) throw new Error('Stream HTTP ' + sseRes.status);
            reconnectAttempts = 0;
            var reader = sseRes.body.getReader();
            var decoder = new TextDecoder();
            return readLoop(reader, decoder);
          })
          .catch(function (err) {
            streamAbortControllers.delete(requestId);
            if (cancelled) return;
            if (userSignal && userSignal.aborted) return;
            console.warn('[LLM Proxy] Relay connection error:', err.message);
            scheduleReconnect();
          });
      }

      function readLoop(reader, decoder) {
        if (cancelled) return Promise.resolve();
        return reader.read().then(function (result) {
          if (result.done) {
            processSSE(true);
            return;
          }
          sseBuffer += decoder.decode(result.value, { stream: true });
          processSSE(false);
          return readLoop(reader, decoder);
        }).catch(function (err) {
          streamAbortControllers.delete(requestId);
          if (cancelled) return;
          if (userSignal && userSignal.aborted) return;
          console.warn('[LLM Proxy] Relay read error:', err.message);
          scheduleReconnect();
        });
      }

      function processSSE(isFinal) {
        var parts = sseBuffer.split('\n');
        if (!isFinal) {
          sseBuffer = parts.pop() || '';
        } else {
          sseBuffer = '';
        }

        for (var i = 0; i < parts.length; i++) {
          if (!parts[i].startsWith('data: ')) continue;
          try {
            var parsed = JSON.parse(parts[i].slice(6));
            if (parsed.done) {
              cancelled = true;
              cleanup();
              var body = chunks.join('');
              if (parsed.error) {
                var status = parsed.upstreamStatus || 502;
                // Prefer errorBody (separated from normal chunks), fall back to accumulated chunks or error message
                var errorContent = parsed.errorBody || body || parsed.error;
                console.warn('[LLM Proxy] Relay error:', parsed.error, '| status:', status);
                notifyCompletion(requestId, true);
                var errStream = new ReadableStream({
                  start: function(c) {
                    c.enqueue(new TextEncoder().encode(errorContent));
                    c.close();
                  }
                });
                settledResolve(new Response(errStream, {
                  status: status,
                  headers: filterHeaders(parsed.upstreamHeaders),
                }));
              } else if (parsed.cancelled) {
                settledReject(new DOMException('Request cancelled', 'AbortError'));
              } else {
                var status = parsed.upstreamStatus || 200;
                var hdrs = filterHeaders(parsed.upstreamHeaders);
                console.log('[LLM Proxy] Relay complete:', requestId,
                  '| status:', status, '| bodyLen:', body.length,
                  '| contentType:', hdrs['content-type'] || 'none',
                  '| chunks:', chunks.length);
                notifyCompletion(requestId, false);
                // Use ReadableStream body instead of string to ensure
                // .json()/.text() resolves asynchronously, matching native
                // fetch timing. String body causes synchronous resolution
                // which breaks wasmoon's Lua coroutine resume mechanism.
                var bodyStream = new ReadableStream({
                  start: function(c) {
                    c.enqueue(new TextEncoder().encode(body));
                    c.close();
                  }
                });
                settledResolve(new Response(bodyStream, {
                  status: status,
                  headers: hdrs,
                }));
              }
              return;
            }
            if (parsed.chunk != null) {
              chunks.push(parsed.chunk);
              offset = parsed.index + 1;
              var entry = activeRequests.get(requestId);
              if (entry) entry.offset = offset;
              persistActiveRequest(requestId, offset);
            }
          } catch (e) {
            // Log parse errors for non-keepalive lines (helps debug SSE issues)
            if (parts[i].trim() && !parts[i].startsWith(':')) {
              console.warn('[LLM Proxy] SSE parse error:', e.message,
                '| lineLen:', parts[i].length, '| prefix:', parts[i].slice(0, 50));
            }
          }
        }
      }

      function scheduleReconnect() {
        if (cancelled) return;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          console.error('[LLM Proxy] Relay: max reconnection attempts for:', requestId);
          cleanup();
          settledReject(new Error('Max reconnection attempts exceeded'));
          return;
        }
        reconnectAttempts++;
        // Skip backoff if tab just became visible (user returned)
        var delay = document.visibilityState === 'visible'
          ? 0
          : Math.min(500 * Math.pow(2, reconnectAttempts - 1), 10000);

        var statusHeaders = {};
        if (PROXY_AUTH_KEY) statusHeaders['x-proxy-auth'] = PROXY_AUTH_KEY;

        fetch(PROXY_URL + '/status/' + requestId, { headers: statusHeaders })
          .then(function (res) {
            if (cancelled) return;
            if (res.status === 404) {
              cleanup();
              settledReject(new Error('Proxy buffer expired'));
              return;
            }
            return res.json().then(function (status) {
              if (cancelled) return;
              if (status.status === 'cancelled') {
                cleanup();
                settledReject(new DOMException('Request cancelled', 'AbortError'));
                return;
              }
              console.log('[LLM Proxy] Relay reconnecting in ' + delay + 'ms' +
                ' (offset=' + offset + ', server chunks=' + status.chunksReceived + ')');
              setTimeout(function () {
                if (!cancelled) { sseBuffer = ''; connect(); }
              }, delay);
            });
          })
          .catch(function (err) {
            if (cancelled) return;
            console.warn('[LLM Proxy] Relay status check failed, retrying in ' + delay + 'ms');
            setTimeout(function () {
              if (!cancelled) scheduleReconnect();
            }, delay);
          });
      }

      // Tab-visibility reconnect is handled by the global visibilitychange handler
      // (which iterates activeRequests + streamAbortControllers for all active requests).
      // No per-request handler needed here.

      connect();
    });
  }

  /**
   * Filter upstream headers to remove hop-by-hop and forbidden headers
   * that cannot be set on a Response object.
   * @param {Object|null} headers
   * @returns {Object}
   */
  function filterHeaders(headers) {
    if (!headers || typeof headers !== 'object') return {};
    var blocked = ['transfer-encoding', 'connection', 'keep-alive',
      'content-encoding', 'content-length'];
    var filtered = {};
    for (var key in headers) {
      if (blocked.indexOf(key.toLowerCase()) < 0) {
        filtered[key] = headers[key];
      }
    }
    return filtered;
  }

  // --- Fallback: /proxy2 (RisuAI's built-in CORS proxy) ---

  /**
   * Route a request through RisuAI's /proxy2 endpoint.
   * Used as fallback when the LLM proxy is unavailable.
   * @param {string} url       Target API URL
   * @param {Object} options   fetch-like options
   * @returns {Promise<Response>}
   */
  async function fetchViaProxy2(url, options) {
    var plainHeaders = headersToPlain(options.headers);
    var auth = '';
    try { auth = localStorage.getItem('risuauth') || ''; } catch (e) { /* ignore */ }

    var proxyH = {
      'risu-header': encodeURIComponent(JSON.stringify(plainHeaders)),
      'risu-url': encodeURIComponent(url),
      'Content-Type': 'application/json',
    };
    if (auth) {
      proxyH['risu-auth'] = auth;
    }

    try {
      return await fetch('/proxy2', {
        method: options.method || 'POST',
        headers: proxyH,
        body: options.body,
        signal: options.signal,
      });
    } catch (err) {
      console.error('[LLM Proxy] /proxy2 fetch failed:', err.message,
        '| url:', url.replace(/[?&]key=[^&]+/g, '?key=<hidden>'),
        '| method:', options.method || 'POST',
        '| bodyType:', options.body ? options.body.constructor.name : 'undefined',
        '| bodyLen:', options.body ? options.body.length || options.body.byteLength || 0 : 0);
      throw err;
    }
  }

  // --- Main: window.userScriptFetch ---

  window.userScriptFetch = async function (url, options) {
    options = options || {};

    var parsed = parseBody(options.body);
    var streaming = isStreamingRequest(url, parsed.obj);
    var safeUrl = url.replace(/[?&]key=[^&]+/g, '?key=<hidden>');

    if (streaming) {
      console.log('[LLM Proxy] Streaming request:',
        safeUrl,
        '| bodyStream:', !!(parsed.obj && parsed.obj.stream),
        '| urlStream:', /streamGenerateContent/.test(url));
      try {
        return await streamViaProxy(url, options, parsed.obj, parsed.raw);
      } catch (err) {
        console.warn('[LLM Proxy] Proxy unavailable (stream), falling back to /proxy2:', err.message);
        return await fetchViaProxy2(url, options);
      }
    }

    // Non-streaming → still route through proxy for tab-switch survival
    console.log('[LLM Proxy] Non-streaming request:',
      safeUrl,
      '| bodyKeys:', parsed.obj ? Object.keys(parsed.obj).join(',') : 'null',
      '| bodyType:', options.body ? options.body.constructor.name : 'undefined');
    try {
      return await relayViaProxy(url, options, parsed.obj, parsed.raw);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('[LLM Proxy] Proxy unavailable (relay), falling back to /proxy2:', err.message);
      return await fetchViaProxy2(url, options);
    }
  };

  console.log('[LLM Proxy] window.userScriptFetch registered (all requests via proxy)');

  // --- Page-load recovery: detect unreflected responses ---

  /**
   * On page load, check sessionStorage for request IDs that were active
   * before the page was refreshed/reopened. Query the proxy to see if
   * any of those requests are still streaming or completed but never
   * consumed by RisuAI (i.e., the client disconnected before the
   * ReadableStream was fully read).
   *
   * If found, show a non-intrusive console warning + optional browser
   * notification so the user knows a response may have been lost.
   */
  (function checkUnreflectedResponses() {
    var persisted;
    try {
      persisted = JSON.parse(sessionStorage.getItem('__llm_proxy_active') || '{}');
    } catch (e) { return; }

    var requestIds = Object.keys(persisted);
    if (requestIds.length === 0) return;

    // Stale threshold: ignore entries older than buffer TTL (default 30min)
    var STALE_MS = 30 * 60 * 1000;
    var now = Date.now();
    var candidates = requestIds.filter(function (id) {
      var entry = persisted[id];
      return entry && entry.ts && (now - entry.ts) < STALE_MS;
    });

    if (candidates.length === 0) {
      // All entries are stale — clean up
      try { sessionStorage.removeItem('__llm_proxy_active'); } catch (e) {}
      return;
    }

    console.log('[LLM Proxy] Checking', candidates.length, 'persisted request(s) from previous session');

    // Query each candidate's status on the proxy
    var headers = {};
    if (PROXY_AUTH_KEY) headers['x-proxy-auth'] = PROXY_AUTH_KEY;

    var checks = candidates.map(function (reqId) {
      return fetch(PROXY_URL + '/status/' + reqId, { headers: headers })
        .then(function (res) {
          if (!res.ok) return null; // 404 = buffer expired, skip
          return res.json();
        })
        .catch(function () { return null; }); // proxy unreachable
    });

    Promise.all(checks).then(function (results) {
      var unreflected = [];
      for (var i = 0; i < results.length; i++) {
        if (!results[i]) {
          // Buffer gone — clean up persisted entry
          removePersistedRequest(candidates[i]);
          continue;
        }
        var status = results[i];
        if (status.status === 'streaming' || status.status === 'completed') {
          unreflected.push({
            requestId: status.requestId,
            status: status.status,
            fullTextLength: status.fullTextLength,
            chunksReceived: status.chunksReceived,
            createdAt: status.createdAt,
          });
        } else {
          // failed/cancelled — clean up
          removePersistedRequest(candidates[i]);
        }
      }

      if (unreflected.length === 0) return;

      console.warn('[LLM Proxy] Found', unreflected.length,
        'unreflected response(s) from previous session:', unreflected);

      // Browser notification (if enabled)
      try {
        if (localStorage.getItem('llm-proxy-notify') === 'true' &&
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted') {
          var body = unreflected.map(function (r) {
            return r.requestId.slice(0, 12) + ' (' + r.status + ', ' + r.fullTextLength + ' chars)';
          }).join('\n');
          var n = new Notification('미반영 LLM 응답 발견', {
            body: body,
            tag: 'llm-proxy-recovery',
            silent: false,
          });
          setTimeout(function () { n.close(); }, 15000);
        }
      } catch (e) { /* notification failed */ }

      // Store for admin dashboard or programmatic access
      window.__llm_proxy_unreflected = unreflected;
    });
  })();
})();
