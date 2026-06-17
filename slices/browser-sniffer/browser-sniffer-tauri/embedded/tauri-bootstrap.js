"use strict";
(() => {
  // ../browser-sniffer-injected/src/sniffer-script.generated.ts
  var snifferScriptSource = '"use strict";\n(() => {\n  // src/install-sniffer.ts\n  var installSniffer = function() {\n    const win = window;\n    const stateKey = /* @__PURE__ */ Symbol.for("browser-sniffer:state");\n    const winWithState = win;\n    const post = (msg) => {\n      if (win.ReactNativeWebView !== void 0 && typeof win.ReactNativeWebView.postMessage === "function") {\n        win.ReactNativeWebView.postMessage(JSON.stringify(msg));\n      }\n    };\n    post({ _tag: "__Ready" });\n    if (winWithState[stateKey] !== void 0) return;\n    const makeLogForLevel = (level) => (...args) => {\n      try {\n        post({ _tag: "Log", level, payload: args });\n      } catch {\n        post({ _tag: "Log", level: "warn", payload: ["JSON unsafe payload failed to log"] });\n      }\n    };\n    const logDebug = makeLogForLevel("debug");\n    const logInfo = makeLogForLevel("info");\n    const logLog = makeLogForLevel("log");\n    const logWarning = makeLogForLevel("warn");\n    const logError = makeLogForLevel("error");\n    Object.assign(globalThis.console, {\n      debug: logDebug,\n      info: logInfo,\n      log: logLog,\n      warn: logWarning,\n      error: logError\n    });\n    const makeRequestId = () => (Math.random() + 1).toString(36).slice(2);\n    const toBase64 = (input) => {\n      if (typeof input === "string") {\n        return btoa(\n          Array.from(new TextEncoder().encode(input), (b) => String.fromCharCode(b)).join("")\n        );\n      }\n      let view;\n      if (input instanceof Uint8Array) {\n        view = input;\n      } else if (input instanceof ArrayBuffer) {\n        view = new Uint8Array(input);\n      } else {\n        view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);\n      }\n      return btoa(Array.from(view, (b) => String.fromCharCode(b)).join(""));\n    };\n    const headersToWire = (headers) => {\n      const entries = Array.from(headers.entries(), ([name, value]) => [\n        name.toLowerCase(),\n        value\n      ]);\n      const getSetCookie = headers.getSetCookie;\n      if (typeof getSetCookie === "function") {\n        const cookies = getSetCookie.call(headers);\n        if (cookies.length > 0) {\n          const withoutSetCookie = entries.filter(([name]) => name !== "set-cookie");\n          for (const cookie of cookies) withoutSetCookie.push(["set-cookie", cookie]);\n          return withoutSetCookie;\n        }\n      }\n      return entries;\n    };\n    const activeRequests = /* @__PURE__ */ new Set();\n    const xhrState = /* @__PURE__ */ new WeakMap();\n    const utf8 = new TextEncoder();\n    const onceLogged = /* @__PURE__ */ new Set();\n    const logOnce = (key, message) => {\n      if (onceLogged.has(key)) return;\n      onceLogged.add(key);\n      logInfo(message);\n    };\n    logInfo("Shimming fetch");\n    const nativeFetch = win.fetch.bind(win);\n    win.fetch = async function(request, init) {\n      const requestId = makeRequestId();\n      let url;\n      let response;\n      try {\n        if (typeof request === "string") {\n          url = request;\n          response = await nativeFetch(new Request(request, init));\n        } else if (request instanceof URL) {\n          url = request.toString();\n          response = await nativeFetch(request, init);\n        } else {\n          url = request.url;\n          response = await nativeFetch(request, init);\n        }\n      } catch (err) {\n        let errorUrl;\n        if (typeof request === "string") {\n          errorUrl = request;\n        } else if (request instanceof URL) {\n          errorUrl = request.toString();\n        } else {\n          errorUrl = request.url;\n        }\n        const message = err instanceof Error ? err.message : String(err);\n        logWarning(`fetch threw before response: ${message}`);\n        activeRequests.add(requestId);\n        post({\n          _tag: "ResponseStart",\n          id: requestId,\n          url: errorUrl,\n          status: 0,\n          statusText: "",\n          headers: []\n        });\n        activeRequests.delete(requestId);\n        post({ _tag: "RequestError", id: requestId, url: errorUrl, message });\n        throw err;\n      }\n      activeRequests.add(requestId);\n      post({\n        _tag: "ResponseStart",\n        id: requestId,\n        url,\n        status: response.status,\n        statusText: response.statusText,\n        headers: headersToWire(response.headers)\n      });\n      const responseType = response.type;\n      const responseUrl = response.url;\n      const responseRedirected = response.redirected;\n      if (response.body !== null) {\n        const ts = new TransformStream({\n          transform(chunk, controller) {\n            if (!activeRequests.has(requestId)) {\n              controller.enqueue(chunk);\n              return;\n            }\n            post({ _tag: "ResponseData", id: requestId, data: toBase64(chunk) });\n            controller.enqueue(chunk);\n          },\n          flush() {\n            if (!activeRequests.has(requestId)) return;\n            activeRequests.delete(requestId);\n            post({ _tag: "ResponseFinished", id: requestId });\n          }\n        });\n        const wrapped = new Response(response.body.pipeThrough(ts), {\n          status: response.status,\n          statusText: response.statusText,\n          headers: response.headers\n        });\n        Object.defineProperty(wrapped, "type", { value: responseType, configurable: true });\n        Object.defineProperty(wrapped, "url", { value: responseUrl, configurable: true });\n        Object.defineProperty(wrapped, "redirected", {\n          value: responseRedirected,\n          configurable: true\n        });\n        response = wrapped;\n      } else {\n        activeRequests.delete(requestId);\n        post({ _tag: "ResponseFinished", id: requestId });\n      }\n      return response;\n    };\n    logInfo("Shimming XMLHttpRequest");\n    const nativeXHROpen = XMLHttpRequest.prototype.open;\n    const nativeXHRSend = XMLHttpRequest.prototype.send;\n    XMLHttpRequest.prototype.open = function(method, url, async, username, password) {\n      xhrState.set(this, { id: makeRequestId(), url: String(url), sentBytes: 0 });\n      nativeXHROpen.call(this, method, url, async ?? true, username ?? null, password ?? null);\n    };\n    XMLHttpRequest.prototype.send = function(body) {\n      const state = xhrState.get(this) ?? { id: makeRequestId(), url: "", sentBytes: 0 };\n      xhrState.set(this, state);\n      const requestId = state.id;\n      let startSent = false;\n      activeRequests.add(requestId);\n      const ensureStartSent = (xhr) => {\n        if (startSent) return;\n        startSent = true;\n        let headers = [];\n        if (typeof xhr.getAllResponseHeaders === "function") {\n          const rawHeaders = xhr.getAllResponseHeaders();\n          headers = rawHeaders.trim().split(/\\r?\\n/).filter(Boolean).map((line) => {\n            const idx = line.indexOf(":");\n            return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()];\n          });\n        }\n        post({\n          _tag: "ResponseStart",\n          id: requestId,\n          url: state.url,\n          status: xhr.status,\n          statusText: xhr.statusText,\n          headers\n        });\n      };\n      const flushTextChunk = (xhr) => {\n        if (xhr.responseType !== "" && xhr.responseType !== "text") return;\n        const fullBytes = utf8.encode(xhr.responseText);\n        if (fullBytes.byteLength <= state.sentBytes) return;\n        const chunkBytes = fullBytes.subarray(state.sentBytes);\n        post({ _tag: "ResponseData", id: requestId, data: toBase64(chunkBytes) });\n        state.sentBytes = fullBytes.byteLength;\n      };\n      const flushFinalNonTextBody = (xhr) => {\n        if (xhr.responseType === "json") {\n          const json = JSON.stringify(xhr.response);\n          if (json === void 0) return;\n          const bytes = utf8.encode(json);\n          if (bytes.byteLength === 0) return;\n          post({ _tag: "ResponseData", id: requestId, data: toBase64(bytes) });\n          return;\n        }\n        if (xhr.responseType === "arraybuffer") {\n          const buf = xhr.response;\n          if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) return;\n          post({ _tag: "ResponseData", id: requestId, data: toBase64(buf) });\n          return;\n        }\n        if (xhr.responseType === "blob") {\n          logOnce(\n            "xhr-blob-unsupported",\n            "XHR responseType=blob captured but body is invisible to the sniffer (v1 limitation)"\n          );\n          return;\n        }\n        if (xhr.responseType === "document") {\n          logOnce(\n            "xhr-document-unsupported",\n            "XHR responseType=document captured but body is invisible to the sniffer (v1 limitation)"\n          );\n          return;\n        }\n      };\n      this.addEventListener("progress", () => {\n        if (xhrState.get(this)?.id !== requestId) return;\n        if (!activeRequests.has(requestId)) return;\n        ensureStartSent(this);\n        flushTextChunk(this);\n      });\n      this.addEventListener(\n        "load",\n        () => {\n          if (xhrState.get(this)?.id !== requestId) return;\n          if (!activeRequests.has(requestId)) return;\n          ensureStartSent(this);\n          flushTextChunk(this);\n          flushFinalNonTextBody(this);\n          activeRequests.delete(requestId);\n          post({ _tag: "ResponseFinished", id: requestId });\n        },\n        { once: true }\n      );\n      this.addEventListener(\n        "error",\n        () => {\n          activeRequests.delete(requestId);\n          post({\n            _tag: "RequestError",\n            id: requestId,\n            url: state.url,\n            message: "XMLHttpRequest error"\n          });\n        },\n        { once: true }\n      );\n      this.addEventListener(\n        "abort",\n        () => {\n          activeRequests.delete(requestId);\n          post({ _tag: "ResponseFinished", id: requestId });\n        },\n        { once: true }\n      );\n      nativeXHRSend.call(this, body ?? null);\n    };\n    const PAGE_CONTENT_CHUNK_BYTES = 65536;\n    const MAX_PAGE_LOAD_RETRIES = 8;\n    const ASYNC_VIEWER_CONTENT_TYPES = /* @__PURE__ */ new Set([\n      "application/json",\n      "application/fhir+json",\n      "application/ld+json",\n      "text/xml",\n      "application/xml"\n    ]);\n    const pageLoadHandler = (attemptOrEvent = 0) => {\n      const attempt = typeof attemptOrEvent === "number" ? attemptOrEvent : 0;\n      const content = document.documentElement.outerHTML;\n      const contentTypeIsAsyncViewer = ASYNC_VIEWER_CONTENT_TYPES.has(\n        // `document.contentType` is a string per the DOM spec; the\n        // optional cast guards jsdom edge cases where it has been\n        // shadowed by a property descriptor.\n        String(document.contentType ?? "")\n      );\n      const documentLooksEmpty = content.length === 0 || !content.includes("<body");\n      const shouldRetry = attempt < MAX_PAGE_LOAD_RETRIES && typeof win.requestAnimationFrame === "function" && (documentLooksEmpty || contentTypeIsAsyncViewer && !content.includes("<pre"));\n      if (shouldRetry) {\n        win.requestAnimationFrame(() => {\n          win.requestAnimationFrame(() => {\n            pageLoadHandler(attempt + 1);\n          });\n        });\n        return;\n      }\n      const pageContentId = makeRequestId();\n      const bytes = utf8.encode(content);\n      post({ _tag: "PageLoaded", url: win.location.href, pageContentId });\n      activeRequests.add(pageContentId);\n      post({\n        _tag: "ResponseStart",\n        id: pageContentId,\n        url: win.location.href,\n        status: 200,\n        statusText: "OK",\n        headers: [["content-type", "text/html"]]\n      });\n      for (let offset = 0; offset < bytes.byteLength; offset += PAGE_CONTENT_CHUNK_BYTES) {\n        if (!activeRequests.has(pageContentId)) break;\n        const slice = bytes.subarray(offset, offset + PAGE_CONTENT_CHUNK_BYTES);\n        post({ _tag: "ResponseData", id: pageContentId, data: toBase64(slice) });\n      }\n      if (activeRequests.has(pageContentId)) {\n        activeRequests.delete(pageContentId);\n        post({ _tag: "ResponseFinished", id: pageContentId });\n      }\n    };\n    win.addEventListener("load", pageLoadHandler);\n    const hostMessageHandler = (event) => {\n      if (event.source !== null) return;\n      if (typeof event.data !== "string") return;\n      let parsed;\n      try {\n        parsed = JSON.parse(event.data);\n      } catch {\n        return;\n      }\n      if (parsed === null || typeof parsed !== "object") return;\n      const msg = parsed;\n      switch (msg._tag) {\n        case "CancelSnifferRequest": {\n          if (typeof msg.id !== "string") return;\n          const wasActive = activeRequests.has(msg.id);\n          activeRequests.delete(msg.id);\n          if (wasActive) {\n            post({ _tag: "Cancelled", id: msg.id });\n          }\n          return;\n        }\n        case "Click": {\n          if (typeof msg.querySelector !== "string" || msg.querySelector.length === 0) return;\n          const target = document.querySelector(msg.querySelector);\n          if (target !== null && "click" in target && typeof target.click === "function") {\n            target.click();\n          }\n          return;\n        }\n        case void 0:\n        default: {\n          logWarning(`Unknown inbound message tag: ${String(msg._tag)}`);\n          return;\n        }\n      }\n    };\n    win.addEventListener("message", hostMessageHandler);\n    winWithState[stateKey] = {\n      nativeFetch,\n      nativeXHROpen,\n      nativeXHRSend,\n      activeRequests,\n      pageLoadHandler,\n      hostMessageHandler\n    };\n  };\n\n  // src/sniffer-entry.ts\n  installSniffer();\n})();';

  // ../browser-sniffer-injected/src/install-sniffer.ts
  var installSniffer = function() {
    const win2 = window;
    const stateKey = /* @__PURE__ */ Symbol.for("browser-sniffer:state");
    const winWithState = win2;
    const post = (msg) => {
      if (win2.ReactNativeWebView !== void 0 && typeof win2.ReactNativeWebView.postMessage === "function") {
        win2.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
    };
    post({ _tag: "__Ready" });
    if (winWithState[stateKey] !== void 0) return;
    const makeLogForLevel = (level) => (...args) => {
      try {
        post({ _tag: "Log", level, payload: args });
      } catch {
        post({ _tag: "Log", level: "warn", payload: ["JSON unsafe payload failed to log"] });
      }
    };
    const logDebug = makeLogForLevel("debug");
    const logInfo = makeLogForLevel("info");
    const logLog = makeLogForLevel("log");
    const logWarning = makeLogForLevel("warn");
    const logError = makeLogForLevel("error");
    Object.assign(globalThis.console, {
      debug: logDebug,
      info: logInfo,
      log: logLog,
      warn: logWarning,
      error: logError
    });
    const makeRequestId = () => (Math.random() + 1).toString(36).slice(2);
    const toBase64 = (input) => {
      if (typeof input === "string") {
        return btoa(
          Array.from(new TextEncoder().encode(input), (b) => String.fromCharCode(b)).join("")
        );
      }
      let view;
      if (input instanceof Uint8Array) {
        view = input;
      } else if (input instanceof ArrayBuffer) {
        view = new Uint8Array(input);
      } else {
        view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
      return btoa(Array.from(view, (b) => String.fromCharCode(b)).join(""));
    };
    const headersToWire = (headers) => {
      const entries = Array.from(headers.entries(), ([name, value]) => [
        name.toLowerCase(),
        value
      ]);
      const getSetCookie = headers.getSetCookie;
      if (typeof getSetCookie === "function") {
        const cookies = getSetCookie.call(headers);
        if (cookies.length > 0) {
          const withoutSetCookie = entries.filter(([name]) => name !== "set-cookie");
          for (const cookie of cookies) withoutSetCookie.push(["set-cookie", cookie]);
          return withoutSetCookie;
        }
      }
      return entries;
    };
    const activeRequests = /* @__PURE__ */ new Set();
    const xhrState = /* @__PURE__ */ new WeakMap();
    const utf8 = new TextEncoder();
    const onceLogged = /* @__PURE__ */ new Set();
    const logOnce = (key, message) => {
      if (onceLogged.has(key)) return;
      onceLogged.add(key);
      logInfo(message);
    };
    logInfo("Shimming fetch");
    const nativeFetch = win2.fetch.bind(win2);
    win2.fetch = async function(request, init) {
      const requestId = makeRequestId();
      let url;
      let response;
      try {
        if (typeof request === "string") {
          url = request;
          response = await nativeFetch(new Request(request, init));
        } else if (request instanceof URL) {
          url = request.toString();
          response = await nativeFetch(request, init);
        } else {
          url = request.url;
          response = await nativeFetch(request, init);
        }
      } catch (err) {
        let errorUrl;
        if (typeof request === "string") {
          errorUrl = request;
        } else if (request instanceof URL) {
          errorUrl = request.toString();
        } else {
          errorUrl = request.url;
        }
        const message = err instanceof Error ? err.message : String(err);
        logWarning(`fetch threw before response: ${message}`);
        activeRequests.add(requestId);
        post({
          _tag: "ResponseStart",
          id: requestId,
          url: errorUrl,
          status: 0,
          statusText: "",
          headers: []
        });
        activeRequests.delete(requestId);
        post({ _tag: "RequestError", id: requestId, url: errorUrl, message });
        throw err;
      }
      activeRequests.add(requestId);
      post({
        _tag: "ResponseStart",
        id: requestId,
        url,
        status: response.status,
        statusText: response.statusText,
        headers: headersToWire(response.headers)
      });
      const responseType = response.type;
      const responseUrl = response.url;
      const responseRedirected = response.redirected;
      if (response.body !== null) {
        const ts = new TransformStream({
          transform(chunk, controller) {
            if (!activeRequests.has(requestId)) {
              controller.enqueue(chunk);
              return;
            }
            post({ _tag: "ResponseData", id: requestId, data: toBase64(chunk) });
            controller.enqueue(chunk);
          },
          flush() {
            if (!activeRequests.has(requestId)) return;
            activeRequests.delete(requestId);
            post({ _tag: "ResponseFinished", id: requestId });
          }
        });
        const wrapped = new Response(response.body.pipeThrough(ts), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
        Object.defineProperty(wrapped, "type", { value: responseType, configurable: true });
        Object.defineProperty(wrapped, "url", { value: responseUrl, configurable: true });
        Object.defineProperty(wrapped, "redirected", {
          value: responseRedirected,
          configurable: true
        });
        response = wrapped;
      } else {
        activeRequests.delete(requestId);
        post({ _tag: "ResponseFinished", id: requestId });
      }
      return response;
    };
    logInfo("Shimming XMLHttpRequest");
    const nativeXHROpen = XMLHttpRequest.prototype.open;
    const nativeXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, async, username, password) {
      xhrState.set(this, { id: makeRequestId(), url: String(url), sentBytes: 0 });
      nativeXHROpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
    };
    XMLHttpRequest.prototype.send = function(body) {
      const state = xhrState.get(this) ?? { id: makeRequestId(), url: "", sentBytes: 0 };
      xhrState.set(this, state);
      const requestId = state.id;
      let startSent = false;
      activeRequests.add(requestId);
      const ensureStartSent = (xhr) => {
        if (startSent) return;
        startSent = true;
        let headers = [];
        if (typeof xhr.getAllResponseHeaders === "function") {
          const rawHeaders = xhr.getAllResponseHeaders();
          headers = rawHeaders.trim().split(/\r?\n/).filter(Boolean).map((line) => {
            const idx = line.indexOf(":");
            return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()];
          });
        }
        post({
          _tag: "ResponseStart",
          id: requestId,
          url: state.url,
          status: xhr.status,
          statusText: xhr.statusText,
          headers
        });
      };
      const flushTextChunk = (xhr) => {
        if (xhr.responseType !== "" && xhr.responseType !== "text") return;
        const fullBytes = utf8.encode(xhr.responseText);
        if (fullBytes.byteLength <= state.sentBytes) return;
        const chunkBytes = fullBytes.subarray(state.sentBytes);
        post({ _tag: "ResponseData", id: requestId, data: toBase64(chunkBytes) });
        state.sentBytes = fullBytes.byteLength;
      };
      const flushFinalNonTextBody = (xhr) => {
        if (xhr.responseType === "json") {
          const json = JSON.stringify(xhr.response);
          if (json === void 0) return;
          const bytes = utf8.encode(json);
          if (bytes.byteLength === 0) return;
          post({ _tag: "ResponseData", id: requestId, data: toBase64(bytes) });
          return;
        }
        if (xhr.responseType === "arraybuffer") {
          const buf = xhr.response;
          if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) return;
          post({ _tag: "ResponseData", id: requestId, data: toBase64(buf) });
          return;
        }
        if (xhr.responseType === "blob") {
          logOnce(
            "xhr-blob-unsupported",
            "XHR responseType=blob captured but body is invisible to the sniffer (v1 limitation)"
          );
          return;
        }
        if (xhr.responseType === "document") {
          logOnce(
            "xhr-document-unsupported",
            "XHR responseType=document captured but body is invisible to the sniffer (v1 limitation)"
          );
          return;
        }
      };
      this.addEventListener("progress", () => {
        if (xhrState.get(this)?.id !== requestId) return;
        if (!activeRequests.has(requestId)) return;
        ensureStartSent(this);
        flushTextChunk(this);
      });
      this.addEventListener(
        "load",
        () => {
          if (xhrState.get(this)?.id !== requestId) return;
          if (!activeRequests.has(requestId)) return;
          ensureStartSent(this);
          flushTextChunk(this);
          flushFinalNonTextBody(this);
          activeRequests.delete(requestId);
          post({ _tag: "ResponseFinished", id: requestId });
        },
        { once: true }
      );
      this.addEventListener(
        "error",
        () => {
          activeRequests.delete(requestId);
          post({
            _tag: "RequestError",
            id: requestId,
            url: state.url,
            message: "XMLHttpRequest error"
          });
        },
        { once: true }
      );
      this.addEventListener(
        "abort",
        () => {
          activeRequests.delete(requestId);
          post({ _tag: "ResponseFinished", id: requestId });
        },
        { once: true }
      );
      nativeXHRSend.call(this, body ?? null);
    };
    const PAGE_CONTENT_CHUNK_BYTES = 65536;
    const MAX_PAGE_LOAD_RETRIES = 8;
    const ASYNC_VIEWER_CONTENT_TYPES = /* @__PURE__ */ new Set([
      "application/json",
      "application/fhir+json",
      "application/ld+json",
      "text/xml",
      "application/xml"
    ]);
    const pageLoadHandler = (attemptOrEvent = 0) => {
      const attempt = typeof attemptOrEvent === "number" ? attemptOrEvent : 0;
      const content = document.documentElement.outerHTML;
      const contentTypeIsAsyncViewer = ASYNC_VIEWER_CONTENT_TYPES.has(
        // `document.contentType` is a string per the DOM spec; the
        // optional cast guards jsdom edge cases where it has been
        // shadowed by a property descriptor.
        String(document.contentType ?? "")
      );
      const documentLooksEmpty = content.length === 0 || !content.includes("<body");
      const shouldRetry = attempt < MAX_PAGE_LOAD_RETRIES && typeof win2.requestAnimationFrame === "function" && (documentLooksEmpty || contentTypeIsAsyncViewer && !content.includes("<pre"));
      if (shouldRetry) {
        win2.requestAnimationFrame(() => {
          win2.requestAnimationFrame(() => {
            pageLoadHandler(attempt + 1);
          });
        });
        return;
      }
      const pageContentId = makeRequestId();
      const bytes = utf8.encode(content);
      post({ _tag: "PageLoaded", url: win2.location.href, pageContentId });
      activeRequests.add(pageContentId);
      post({
        _tag: "ResponseStart",
        id: pageContentId,
        url: win2.location.href,
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/html"]]
      });
      for (let offset = 0; offset < bytes.byteLength; offset += PAGE_CONTENT_CHUNK_BYTES) {
        if (!activeRequests.has(pageContentId)) break;
        const slice = bytes.subarray(offset, offset + PAGE_CONTENT_CHUNK_BYTES);
        post({ _tag: "ResponseData", id: pageContentId, data: toBase64(slice) });
      }
      if (activeRequests.has(pageContentId)) {
        activeRequests.delete(pageContentId);
        post({ _tag: "ResponseFinished", id: pageContentId });
      }
    };
    win2.addEventListener("load", pageLoadHandler);
    const hostMessageHandler = (event2) => {
      if (event2.source !== null) return;
      if (typeof event2.data !== "string") return;
      let parsed;
      try {
        parsed = JSON.parse(event2.data);
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== "object") return;
      const msg = parsed;
      switch (msg._tag) {
        case "CancelSnifferRequest": {
          if (typeof msg.id !== "string") return;
          const wasActive = activeRequests.has(msg.id);
          activeRequests.delete(msg.id);
          if (wasActive) {
            post({ _tag: "Cancelled", id: msg.id });
          }
          return;
        }
        case "Click": {
          if (typeof msg.querySelector !== "string" || msg.querySelector.length === 0) return;
          const target = document.querySelector(msg.querySelector);
          if (target !== null && "click" in target && typeof target.click === "function") {
            target.click();
          }
          return;
        }
        case void 0:
        default: {
          logWarning(`Unknown inbound message tag: ${String(msg._tag)}`);
          return;
        }
      }
    };
    win2.addEventListener("message", hostMessageHandler);
    winWithState[stateKey] = {
      nativeFetch,
      nativeXHROpen,
      nativeXHRSend,
      activeRequests,
      pageLoadHandler,
      hostMessageHandler
    };
  };

  // ../browser-sniffer-injected/src/index.ts
  var SNIFFER_SCRIPT_MIN_LENGTH = 1e3;
  var snifferScript = snifferScriptSource;
  if (snifferScript.length < SNIFFER_SCRIPT_MIN_LENGTH) {
    throw new Error(
      `browser-sniffer-injected: snifferScript is ${snifferScript.length} chars, expected at least ${SNIFFER_SCRIPT_MIN_LENGTH}. The generated file 'sniffer-script.generated.ts' looks empty or stale \u2014 run \`vp run generate-sniffer-script\` to regenerate it. Script preview: ${snifferScript.slice(0, 200)}`
    );
  }

  // src/tauri-sniffer-entry.ts
  var BRIDGE_EVENT = "bridge";
  var win = globalThis;
  var event = win.__TAURI__?.event;
  var isTauriInternalUrl = (url) => {
    if (typeof url !== "string") return false;
    return url.startsWith("ipc://") || url.startsWith("tauri://") || url.startsWith("http://ipc.localhost") || url.startsWith("https://ipc.localhost") || url.startsWith("http://tauri.localhost") || url.startsWith("https://tauri.localhost");
  };
  var TAURI_IPC_FALLBACK_WARN_PREFIX = "IPC custom protocol failed";
  var SNIFFER_FETCH_THREW_WARN_PREFIX = "fetch threw before response:";
  var isTauriIpcFallbackWarning = (parsed) => {
    if (parsed.level !== "warn") return false;
    const payload = parsed.payload;
    if (!Array.isArray(payload) || payload.length === 0) return false;
    const head = payload[0];
    return typeof head === "string" && head.startsWith(TAURI_IPC_FALLBACK_WARN_PREFIX);
  };
  var isSnifferFetchThrewWarning = (parsed) => {
    if (parsed.level !== "warn") return false;
    const payload = parsed.payload;
    if (!Array.isArray(payload) || payload.length === 0) return false;
    const head = payload[0];
    return typeof head === "string" && head.startsWith(SNIFFER_FETCH_THREW_WARN_PREFIX);
  };
  var internalRequestIds = /* @__PURE__ */ new Set();
  var emitChain = Promise.resolve();
  var bufferedFetchErrorLog = null;
  if (event !== void 0) {
    win.ReactNativeWebView = {
      postMessage(jsonStr) {
        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          return;
        }
        if (parsed === null || typeof parsed !== "object" || !("_tag" in parsed)) return;
        const tag = parsed._tag;
        if (typeof tag !== "string") return;
        const record = parsed;
        if (tag === "Log" && isTauriIpcFallbackWarning(record)) return;
        if (tag === "Log" && isSnifferFetchThrewWarning(record)) {
          bufferedFetchErrorLog = record;
          return;
        }
        if (bufferedFetchErrorLog !== null) {
          const buffered = bufferedFetchErrorLog;
          bufferedFetchErrorLog = null;
          const isInternalResponseStart = tag === "ResponseStart" && isTauriInternalUrl(record.url);
          if (!isInternalResponseStart) {
            emitChain = emitChain.then(() => event.emit(BRIDGE_EVENT, buffered)).catch(() => {
            });
          }
        }
        if (tag === "ResponseStart" && isTauriInternalUrl(record.url)) {
          if (typeof record.id === "string") internalRequestIds.add(record.id);
          return;
        }
        if ((tag === "ResponseData" || tag === "ResponseFinished" || tag === "RequestError" || tag === "Cancelled") && typeof record.id === "string" && internalRequestIds.has(record.id)) {
          if (tag === "ResponseFinished" || tag === "RequestError" || tag === "Cancelled") {
            internalRequestIds.delete(record.id);
          }
          return;
        }
        emitChain = emitChain.then(() => event.emit(BRIDGE_EVENT, parsed)).catch(() => {
        });
      }
    };
    const inboundTags = /* @__PURE__ */ new Set(["Click", "CancelSnifferRequest"]);
    void event.listen(BRIDGE_EVENT, ({ payload }) => {
      if (payload === null || typeof payload !== "object" || !("_tag" in payload)) return;
      const tag = payload._tag;
      if (typeof tag !== "string" || !inboundTags.has(tag)) return;
      const data = JSON.stringify(payload);
      win.dispatchEvent(new MessageEvent("message", { data }));
    });
  }
  installSniffer();
})();