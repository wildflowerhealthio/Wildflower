// oxlint-disable eslint-plugin-unicorn/consistent-function-scoping -- installSniffer is esbuild-bundled at build time and injected into arbitrary third-party pages; nested helpers MUST stay inside the function body so they're captured in the IIFE bundle. Moving them out would break the bundle.

import type {
  CancelSnifferRequestMessageBody,
  CancelledMessageBody,
  PageActionMessageBody,
  PageLoadedMessageBody,
  RequestErrorMessageBody,
  ResponseDataMessageBody,
  ResponseFinishedMessageBody,
  ResponseStartMessageBody,
} from 'browser-sniffer-core'
import { type Schema, Match, Predicate } from 'effect'
import type { Logging } from 'effect-messaging-core'
import type { TauriEventApi } from 'effect-messaging-tauri'
import type { JsonValue } from 'kitchen-sink/schema'

/**
 * Browser-side sniffer installed into an arbitrary third-party page.
 *
 * esbuild bundles this function into a self-contained IIFE
 * (`scripts/build-tauri-bootstrap.mts`), so every helper, reference, and
 * piece of state must live *inside* the function body — top-level value
 * imports or module-scope closures resolve to nothing in the injected
 * page. Type-only imports are erased and so survive.
 *
 * Wire format:
 *   - Emits `Log`, `ResponseStart`, `ResponseData`, `ResponseFinished`,
 *     `RequestError`, `Cancelled`, `PageLoaded` on the multiplexed
 *     `BRIDGE_EVENT` channel (discriminated by `_tag`). `PageLoaded` is held
 *     until the page *settles* — no DOM mutations and no in-flight fetch/XHR
 *     for a continuous quiet window, or a hard ceiling — rather than firing on
 *     the raw `window.load` event (see the settle watch below). Emits are
 *     fire-and-forget here; the wrapping `makeFilteringEventBus` serializes
 *     them to keep the ~64KB `ResponseData` chunks FIFO (see
 *     `filter-tauri-internal.ts`).
 *   - Listens for Host→Web messages on the same channel, demuxing by
 *     `_tag` (`CancelSnifferRequest` / `PageAction`, the latter further
 *     demuxed by its inner `action.kind`). No `message`-event indirection
 *     or `source === null` guard: only Tauri IPC can invoke a Tauri
 *     listener, so page scripts can't spoof inbound messages.
 *
 * Idempotent: a `Symbol.for('browser-sniffer:state')` slot on `window`
 * holds the captured natives, tracker state, and pending unlistens;
 * re-injection drains the prior unlistens and exits early. Caveat: a
 * re-injected *newer* script reuses the stale state and never installs —
 * v1 accepts this (no version tag). Tests: `tests/install-sniffer.test.ts`.
 */

/** Wire form posted Web→Host: JSON-stringifiable, base64 `data`. */
type SnifferOutboundMessage =
  | Schema.Schema.Encoded<typeof Logging.LogMessageBody>
  | Schema.Schema.Encoded<typeof ResponseStartMessageBody>
  | Schema.Schema.Encoded<typeof ResponseDataMessageBody>
  | Schema.Schema.Encoded<typeof ResponseFinishedMessageBody>
  | Schema.Schema.Encoded<typeof RequestErrorMessageBody>
  | Schema.Schema.Encoded<typeof CancelledMessageBody>
  | Schema.Schema.Encoded<typeof PageLoadedMessageBody>

/** Wire form received Host→Web. */
type SnifferInboundMessage =
  | Schema.Schema.Encoded<typeof CancelSnifferRequestMessageBody>
  | Schema.Schema.Encoded<typeof PageActionMessageBody>

interface SnifferState {
  readonly nativeFetch: typeof globalThis.fetch
  readonly nativeXHROpen: XMLHttpRequest['open']
  readonly nativeXHRSend: XMLHttpRequest['send']
  readonly activeRequests: Set<string>
  /**
   * The sole `window.load` listener. Arms the settlement detector — which fires
   * `PageLoaded` once the page is quiet — rather than snapshotting synchronously.
   * Named `pageLoadHandler` because it remains the one `load` handler.
   */
  readonly pageLoadHandler: () => void
  /**
   * Tear the settle watch down: disconnect the `MutationObserver` and clear the
   * quiet-window / ceiling timers. Idempotent. Settlement calls it itself before
   * snapshotting; exposed so tests can reset a mid-flight watch between cases.
   */
  readonly teardownSettleWatch: () => void
  /** Resolved `event.listen(...)` cleanups; drained on re-injection. */
  readonly unlistens: Array<(() => void) | Promise<() => void>>
}

/**
 * Per-install tuning for the page-settlement detector, so tests can drive it
 * deterministically. Production passes none and gets the in-body defaults.
 */
interface InstallSnifferOptions {
  readonly settle?: {
    /** Continuous quiet (no DOM mutation, no in-flight request) before firing `PageLoaded`. */
    readonly quietWindowMs?: number
    /** Hard ceiling from `load`: fire `PageLoaded` even if the page never fully quiesces. */
    readonly maxWaitMs?: number
  }
}

/**
 * Public `Symbol.for` key under which the sniffer stashes its state on
 * `window`. Tests use this to reset between cases; the injected
 * function body looks up the same registry symbol via
 * `Symbol.for('browser-sniffer:state')` (a literal string — closure
 * capture over `SNIFFER_STATE_KEY` would not survive esbuild's IIFE
 * boundary).
 */
const SNIFFER_STATE_KEY: symbol = Symbol.for('browser-sniffer:state')

/**
 * Tauri event name for the multiplexed bridge channel. Hardcoded rather
 * than imported from `effect-messaging-tauri` because the bundled IIFE
 * can't pull in workspace modules; `bootstrap.test.ts` guards it against
 * the canonical `BRIDGE_EVENT` in event-names.ts.
 */
const BRIDGE_EVENT = 'bridge'

/**
 * Install the sniffer on the current page. Idempotent. On re-injection,
 * drains any pending unlistens from the previous run before short-
 * circuiting on the symbol-keyed state slot.
 *
 * Takes the Tauri event bus as an explicit parameter so the function
 * is testable without mocking `window.__TAURI__` — the
 * `tauri-sniffer-entry.ts` wrapper looks the global up once and passes
 * it in.
 */
const installSniffer = function (eventBus: TauriEventApi, options?: InstallSnifferOptions): void {
  const win = window
  // Single state slot keyed by a registry symbol — eliminates name
  // collisions with arbitrary host-page globals and gives idempotency
  // (re-injection finds the slot and returns early). `unique symbol`
  // on the `const` lets the computed-property type below name *this
  // specific slot* (`[stateKey]: …`) rather than every possible symbol
  // key (`[k: symbol]: …`).
  const stateKey: unique symbol = Symbol.for('browser-sniffer:state')
  type WinWithState = typeof win & { [stateKey]: SnifferState | undefined }
  // The cast adds the (currently-absent) state slot to the window's
  // type; runtime semantics are unchanged.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const winWithState = win as WinWithState

  // On re-injection (the script ran on a previous page in this webview)
  // drain the prior run's listener cleanups before the early-return.
  // Without this, every navigation accumulates listener IDs on the
  // Rust side that point at the destroyed JS context.
  const existing = winWithState[stateKey]
  if (existing !== undefined) {
    for (const entry of existing.unlistens) {
      void Promise.resolve(entry).then((unlisten) => {
        unlisten()
      })
    }
    return
  }

  const post = (msg: SnifferOutboundMessage): void => {
    void eventBus.emit(BRIDGE_EVENT, msg)
  }

  // Per-level Log emitters. The host re-emits each `Log` message via
  // `console[level](...payload)` on its side, so each page-side
  // `console.<level>(...args)` flows verbatim to the host's matching
  // native sink. Mirrors the `makeLogForLevel` factory in
  // `apps/wildflower-react/src/bridges/build-transport.ts`; the
  // injected script can't import the Effect runtime, so this is the
  // plain-JS analogue. `LogLevel` is type-imported from `Logging` so
  // any future expansion of the bridge's level union surfaces here at
  // compile time. (Type-only imports survive esbuild's bundle.)
  const makeLogForLevel =
    (level: Logging.LogLevel) =>
    (...args: unknown[]): void => {
      // Try to log, but fail for unsafe payloads. We assert the
      // JSON-safe shape rather than validating it: `logging.ts` narrows
      // with `Schema.is(JsonValue)`, but that's a runtime value and only
      // type-only imports survive this file's IIFE bundle — so the
      // schema guard isn't available here. The `catch` below is the
      // runtime backstop: a non-JSON-safe arg makes `post`'s encode
      // throw and we fall through to the warn payload.
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        post({ _tag: 'Log', level, payload: args as readonly JsonValue[] })
      } catch {
        post({ _tag: 'Log', level: 'warn', payload: ['JSON unsafe payload failed to log'] })
      }
    }
  const logDebug = makeLogForLevel('debug')
  const logInfo = makeLogForLevel('info')
  const logLog = makeLogForLevel('log')
  const logWarning = makeLogForLevel('warn')
  const logError = makeLogForLevel('error')

  // Override the page's console methods so any page-side `console.<level>`
  // call is forwarded to the host as a structured Log. We assign onto the
  // global `console` object directly — its identity is preserved (we only
  // swap the methods, not the object), so any page code that captured a
  // bound reference to `console` still sees the new methods.
  Object.assign(globalThis.console, {
    debug: logDebug,
    info: logInfo,
    log: logLog,
    warn: logWarning,
    error: logError,
  })

  // Per-request correlation key. `Math.random() + 1` keeps the value in
  // `[1, 2)` so `.toString(36)` yields a string of the form
  // `"1.xyz123…"`; `.slice(2)` drops the `"1."` leaving a non-empty
  // base-36 alphanumeric suffix. Good enough for in-page request
  // correlation — no cryptographic guarantees are needed.
  const makeRequestId = (): string => (Math.random() + 1).toString(36).slice(2)

  /**
   * Encode bytes from any input into a base64 string. The
   * `ArrayBufferView` branch preserves `byteOffset` / `byteLength` so
   * a sliced view (`u8.subarray(4, 12)`, a `DataView`, …) encodes
   * exactly the view's range — not the entire backing buffer.
   */
  const toBase64 = (input: string | ArrayBuffer | ArrayBufferView): string => {
    if (typeof input === 'string') {
      return btoa(
        Array.from(new TextEncoder().encode(input), (b) => String.fromCharCode(b)).join('')
      )
    }
    let view: Uint8Array
    if (input instanceof Uint8Array) {
      view = input
    } else if (input instanceof ArrayBuffer) {
      view = new Uint8Array(input)
    } else {
      view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    }
    return btoa(Array.from(view, (b) => String.fromCharCode(b)).join(''))
  }

  /**
   * Lossless extraction of headers as ordered `(name, value)` pairs.
   * `Headers.entries()` may collapse repeated headers (notably
   * `Set-Cookie`) under spec-legacy comma joining; when
   * `Headers.getSetCookie()` is available we use it to recover the
   * per-cookie set.
   */
  const headersToWire = (headers: Headers): [string, string][] => {
    const entries = Array.from(headers.entries(), ([name, value]): [string, string] => [
      name.toLowerCase(),
      value,
    ])
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
    if (typeof getSetCookie === 'function') {
      const cookies = getSetCookie.call(headers)
      if (cookies.length > 0) {
        const withoutSetCookie = entries.filter(([name]) => name !== 'set-cookie')
        for (const cookie of cookies) withoutSetCookie.push(['set-cookie', cookie])
        return withoutSetCookie
      }
    }
    return entries
  }

  // In-flight request IDs, for cancellation and for the settle watcher's
  // network-idle check. Maintained via `trackRequestStart` / `trackRequestEnd`
  // from initiation (fetch: before response headers; XHR: `send`) to terminal.
  const activeRequests = new Set<string>()

  // The settle watcher's activity signal, poked by the fetch/XHR shims through
  // `trackRequest*`. A no-op until `load` starts the watch (then it re-arms the
  // quiet window), and a no-op again once settled.
  const noopActivity = (): void => {}
  let signalActivity: () => void = noopActivity
  const trackRequestStart = (id: string): void => {
    activeRequests.add(id)
    signalActivity()
  }
  const trackRequestEnd = (id: string): void => {
    activeRequests.delete(id)
    signalActivity()
  }
  // Per-XHR state keyed by instance — avoids polluting `XMLHttpRequest`
  // instances with `_sniffer*` properties.
  interface XhrState {
    id: string
    url: string
    /** Number of UTF-8 bytes already posted as ResponseData chunks. */
    sentBytes: number
    /** Tauri-internal IPC request — `send` hands to native, unsniffed. */
    internal: boolean
  }
  const xhrState = new WeakMap<XMLHttpRequest, XhrState>()

  // Single shared encoder; the closure preserves it across calls.
  const utf8 = new TextEncoder()

  // One-shot Log emitter so we don't spam for repeated unsupported
  // observations (e.g., XHR `blob` / `document` response types).
  const onceLogged = new Set<string>()
  const logOnce = (key: string, message: string): void => {
    if (onceLogged.has(key)) return
    onceLogged.add(key)
    logInfo(message)
  }

  // Tauri's own IPC transport fetches `ipc://localhost/...` from this
  // same JS context; without a guard every host call gets re-sniffed and
  // forwarded back, re-entering the bridge. Skip these at the source — the
  // fetch still runs natively, we just emit nothing.
  const TAURI_INTERNAL_HTTP_ORIGINS = [
    'http://ipc.localhost',
    'https://ipc.localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
  ]
  const isTauriInternalUrl = (candidate: string): boolean => {
    if (candidate.startsWith('ipc://') || candidate.startsWith('tauri://')) return true
    // Match the exact IPC-fallback host — followed by a port, path, query,
    // fragment, or end-of-string — not a bare prefix, so a genuine external
    // `https://ipc.localhost.evil.example/…` is still sniffed rather than
    // silently handed to native.
    for (const origin of TAURI_INTERNAL_HTTP_ORIGINS) {
      if (candidate === origin) return true
      if (candidate.startsWith(origin)) {
        const boundary = candidate[origin.length]
        if (boundary === '/' || boundary === ':' || boundary === '?' || boundary === '#') {
          return true
        }
      }
    }
    return false
  }

  // Resolve a request URL against the page's own `location` so relative
  // requests (`/api/fhir/Patient/123`) are reported absolute. The
  // downstream `UrlMatch` entity matchers require a `://host…` shape
  // (see `collector-fundamentals/model/url-match.ts`), so a verbatim
  // relative URL would never match and the capture would be silently
  // cancelled (issue #373). The sniffer is the only layer that knows the
  // page's base, so normalize here — every consumer then sees absolute
  // URLs. Idempotent on already-absolute URLs (`fetch(new Request('/x'))`
  // and protocol-relative `//host/x` both round-trip). Falls back to the
  // raw string for exotic schemes `new URL` rejects (`data:`, `blob:`,
  // custom) so those still surface rather than throwing.
  const toAbsoluteUrl = (raw: string): string => {
    try {
      return new URL(raw, win.location.href).href
    } catch {
      return raw
    }
  }

  // Fetch shim — capture the native into a const so the closure has a
  // typed, definitely-defined reference (no `!` later).
  logInfo('Shimming fetch')
  const nativeFetch = win.fetch.bind(win)

  win.fetch = async function (
    this: unknown,
    request: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    // Tauri-internal IPC — hand straight to native, unsniffed (see
    // `isTauriInternalUrl`). Pass the original input through unchanged so
    // we don't re-wrap a string in `new Request(...)` (which rejects the
    // custom `ipc:` scheme in some engines).
    const probeUrl = Match.value(request).pipe(
      Match.when(Predicate.isString, (s) => s),
      Match.when(Match.instanceOf(URL), (u) => u.toString()),
      Match.when({ url: Predicate.isString }, (r) => r.url),
      Match.orElse((r) => r.toString())
    )

    if (isTauriInternalUrl(probeUrl)) {
      return nativeFetch(request, init)
    }

    const requestId = makeRequestId()
    let url: string
    let response: Response

    // Count the request as in-flight *before* awaiting the response so a slow
    // header round-trip keeps the page from settling prematurely. Every terminal
    // path below balances this with `trackRequestEnd`.
    trackRequestStart(requestId)

    try {
      if (typeof request === 'string') {
        url = toAbsoluteUrl(request)
        response = await nativeFetch(new Request(request, init))
      } else if (request instanceof URL) {
        url = request.toString()
        response = await nativeFetch(request, init)
      } else {
        url = request.url
        response = await nativeFetch(request, init)
      }
    } catch (err) {
      // Pre-response throw (DNS failure, TLS error, AbortSignal, …).
      // Emit Log → synthetic ResponseStart → RequestError so the host
      // sees the full Start→terminal pair (host-side `Cancelled` /
      // `RequestError` handlers assume a prior `ResponseStart`).
      // We re-throw so the caller's catch still fires; the synthetic
      // pair is purely the wire-side observation.
      let errorUrl: string
      if (typeof request === 'string') {
        errorUrl = toAbsoluteUrl(request)
      } else if (request instanceof URL) {
        errorUrl = request.toString()
      } else {
        errorUrl = request.url
      }
      const message = err instanceof Error ? err.message : String(err)
      logWarning(`fetch threw before response: ${message}`)
      post({
        _tag: 'ResponseStart',
        id: requestId,
        url: errorUrl,
        status: 0,
        statusText: '',
        headers: [],
      })
      trackRequestEnd(requestId)
      post({ _tag: 'RequestError', id: requestId, url: errorUrl, message })
      throw err
    }

    post({
      _tag: 'ResponseStart',
      id: requestId,
      url,
      status: response.status,
      statusText: response.statusText,
      headers: headersToWire(response.headers),
    })

    // Pin the response identity surface so re-wrapping (below) doesn't
    // silently drop `type` / `url` / `redirected` — code that branches
    // on `response.type === 'opaque'` or reads `response.url` would
    // otherwise see the wrapping defaults.
    const responseType = response.type
    const responseUrl = response.url
    const responseRedirected = response.redirected

    if (response.body !== null) {
      const ts = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller): void {
          if (!activeRequests.has(requestId)) {
            controller.enqueue(chunk)
            return
          }
          post({ _tag: 'ResponseData', id: requestId, data: toBase64(chunk) })
          controller.enqueue(chunk)
        },
        flush(): void {
          if (!activeRequests.has(requestId)) return
          trackRequestEnd(requestId)
          post({ _tag: 'ResponseFinished', id: requestId })
        },
      })
      const wrapped = new Response(response.body.pipeThrough(ts), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      // Restore the lost-on-wrap properties via property descriptors —
      // `new Response(...)` initialises these to `'default'`, `''`,
      // `false`. Use `defineProperty` because they're read-only own
      // properties on the spec-compliant Response.
      Object.defineProperty(wrapped, 'type', { value: responseType, configurable: true })
      Object.defineProperty(wrapped, 'url', { value: responseUrl, configurable: true })
      Object.defineProperty(wrapped, 'redirected', {
        value: responseRedirected,
        configurable: true,
      })
      response = wrapped
    } else {
      trackRequestEnd(requestId)
      post({ _tag: 'ResponseFinished', id: requestId })
    }

    return response
  }

  // XHR shim — same capture pattern; per-XHR state lives in a WeakMap.
  logInfo('Shimming XMLHttpRequest')
  // The captured prototype methods are always invoked via `.call(this, …)`
  // below, so the `unbound-method` rule's concern (lost `this`) doesn't
  // apply — we re-supply `this` at every call site.
  // oxlint-disable-next-line typescript-eslint/unbound-method
  const nativeXHROpen = XMLHttpRequest.prototype.open
  // oxlint-disable-next-line typescript-eslint/unbound-method
  const nativeXHRSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    const rawUrl = String(url)
    xhrState.set(this, {
      id: makeRequestId(),
      // Report absolute (issue #373) so downstream `UrlMatch` can match a
      // same-origin relative request. The internal guard stays on the RAW
      // string — normalizing first could rewrite a relative `/foo` into
      // `https://tauri.localhost/foo` and flip the guard's decision.
      url: toAbsoluteUrl(rawUrl),
      sentBytes: 0,
      internal: isTauriInternalUrl(rawUrl),
    })
    nativeXHROpen.call(this, method, url, async ?? true, username ?? null, password ?? null)
  } satisfies XMLHttpRequest['open']

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null
  ): void {
    const state = xhrState.get(this) ?? {
      id: makeRequestId(),
      url: '',
      sentBytes: 0,
      internal: false,
    }
    xhrState.set(this, state)
    // Tauri-internal IPC — run it natively without sniffing (see
    // `isTauriInternalUrl`).
    if (state.internal) {
      nativeXHRSend.call(this, body ?? null)
      return
    }
    const requestId = state.id
    let startSent = false

    trackRequestStart(requestId)

    const ensureStartSent = (xhr: XMLHttpRequest): void => {
      if (startSent) return
      startSent = true
      let headers: [string, string][] = []
      if (typeof xhr.getAllResponseHeaders === 'function') {
        const rawHeaders = xhr.getAllResponseHeaders()
        headers = rawHeaders
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line): [string, string] => {
            const idx = line.indexOf(':')
            return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()]
          })
      }
      post({
        _tag: 'ResponseStart',
        id: requestId,
        url: state.url,
        status: xhr.status,
        statusText: xhr.statusText,
        headers,
      })
    }

    /**
     * Flush any not-yet-sent text-mode payload. `sentBytes` is a UTF-8
     * byte count (not a character index) so chunks across non-BMP code
     * points (surrogate pairs) stay byte-correct on the host side.
     */
    const flushTextChunk = (xhr: XMLHttpRequest): void => {
      if (xhr.responseType !== '' && xhr.responseType !== 'text') return
      const fullBytes = utf8.encode(xhr.responseText)
      if (fullBytes.byteLength <= state.sentBytes) return
      const chunkBytes = fullBytes.subarray(state.sentBytes)
      post({ _tag: 'ResponseData', id: requestId, data: toBase64(chunkBytes) })
      state.sentBytes = fullBytes.byteLength
    }

    /**
     * Final-flush for non-text response types (`json`, `arraybuffer`).
     * `xhr.response` is only well-defined after `load`, so this is
     * called once from the `load` handler. `blob` and `document` are
     * skipped with a one-shot Log (their bodies are async-only on
     * `blob` and DOM-shaped on `document` — outside the v1 surface).
     */
    const flushFinalNonTextBody = (xhr: XMLHttpRequest): void => {
      if (xhr.responseType === 'json') {
        const json = JSON.stringify(xhr.response)
        if (json === undefined) return
        const bytes = utf8.encode(json)
        if (bytes.byteLength === 0) return
        post({ _tag: 'ResponseData', id: requestId, data: toBase64(bytes) })
        return
      }
      if (xhr.responseType === 'arraybuffer') {
        const buf: unknown = xhr.response
        if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) return
        post({ _tag: 'ResponseData', id: requestId, data: toBase64(buf) })
        return
      }
      if (xhr.responseType === 'blob') {
        logOnce(
          'xhr-blob-unsupported',
          'XHR responseType=blob captured but body is invisible to the sniffer (v1 limitation)'
        )
        return
      }
      if (xhr.responseType === 'document') {
        logOnce(
          'xhr-document-unsupported',
          'XHR responseType=document captured but body is invisible to the sniffer (v1 limitation)'
        )
        return
      }
    }

    this.addEventListener('progress', () => {
      // Guard against stale listeners from XHR reuse — `xhrState.get(this).id`
      // can rotate if `open()` is called again on the same instance.
      if (xhrState.get(this)?.id !== requestId) return
      if (!activeRequests.has(requestId)) return
      ensureStartSent(this)
      flushTextChunk(this)
    })

    this.addEventListener(
      'load',
      () => {
        if (xhrState.get(this)?.id !== requestId) return
        if (!activeRequests.has(requestId)) return
        ensureStartSent(this)
        flushTextChunk(this)
        flushFinalNonTextBody(this)
        trackRequestEnd(requestId)
        post({ _tag: 'ResponseFinished', id: requestId })
      },
      { once: true }
    )

    this.addEventListener(
      'error',
      () => {
        // Stale-id guard (XHR reuse): a `{ once: true }` listener from a
        // prior `send()` that never fired is still registered; without this
        // it would post a terminal under the old id. Mirror `progress`/`load`.
        if (xhrState.get(this)?.id !== requestId) return
        if (!activeRequests.has(requestId)) return
        // Emit a synthetic `ResponseStart` before the terminal so the host
        // sees the full Start→terminal pair. A network-level `error` fires
        // with `xhr.status === 0` and empty headers, so the synthesized start
        // carries `status: 0, headers: []` — exactly the fetch shim's
        // pre-response synthetic start. Idempotent: a no-op if `progress`
        // already sent it. Without it, `handleRequestError` finds no tracked
        // response and drops the failure with only a WARN.
        ensureStartSent(this)
        trackRequestEnd(requestId)
        post({
          _tag: 'RequestError',
          id: requestId,
          url: state.url,
          message: 'XMLHttpRequest error',
        })
      },
      { once: true }
    )
    this.addEventListener(
      'abort',
      () => {
        if (xhrState.get(this)?.id !== requestId) return
        if (!activeRequests.has(requestId)) return
        // Same Start-before-terminal invariant as `error`. Emit `RequestError`
        // rather than `ResponseFinished`: an aborted request's body is
        // partial, and a `ResponseFinished` would hand that truncated payload
        // to `entity.parse` as if complete — surfacing a confusing `ParseError`
        // instead of a clean cancel/error terminal.
        ensureStartSent(this)
        trackRequestEnd(requestId)
        post({
          _tag: 'RequestError',
          id: requestId,
          url: state.url,
          message: 'XMLHttpRequest aborted',
        })
      },
      { once: true }
    )

    nativeXHRSend.call(this, body ?? null)
  } satisfies XMLHttpRequest['send']

  // Page-content capture, gated on settlement rather than raw `window.load` (the
  // settle watch below). `PageLoaded` is a notification; the DOM body streams
  // through the standard Response triple, chunked. See the sniffer's Architecture
  // Explanation § settlement for the why.
  const PAGE_CONTENT_CHUNK_BYTES = 65536
  // Settlement thresholds. Overridable via `options.settle` so tests can drive
  // the watcher deterministically; production callers pass none and get these.
  const SETTLE_QUIET_WINDOW_MS = 1000
  const SETTLE_MAX_WAIT_MS = 10_000
  const quietWindowMs = options?.settle?.quietWindowMs ?? SETTLE_QUIET_WINDOW_MS
  const maxWaitMs = options?.settle?.maxWaitMs ?? SETTLE_MAX_WAIT_MS

  // At most one snapshot per installed page — guards a re-fired `load`, a
  // quiet-window/ceiling race, and re-injection. Reset per page by re-injection
  // rebuilding the closure.
  let pageSnapshotEmitted = false
  let settleWatchStarted = false
  let quietTimer: ReturnType<typeof setTimeout> | undefined
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined
  let observer: MutationObserver | undefined

  // Snapshot the DOM + stream it, run once the page is quiet (via the settle
  // watch below) rather than on raw `load`.
  const emitPageLoaded = (): void => {
    if (pageSnapshotEmitted) return
    pageSnapshotEmitted = true
    const content = document.documentElement.outerHTML
    const pageContentId = makeRequestId()
    const bytes = utf8.encode(content)
    post({ _tag: 'PageLoaded', url: win.location.href, pageContentId })
    activeRequests.add(pageContentId)
    post({
      _tag: 'ResponseStart',
      id: pageContentId,
      url: win.location.href,
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'text/html']],
    })
    for (let offset = 0; offset < bytes.byteLength; offset += PAGE_CONTENT_CHUNK_BYTES) {
      if (!activeRequests.has(pageContentId)) break
      const slice = bytes.subarray(offset, offset + PAGE_CONTENT_CHUNK_BYTES)
      post({ _tag: 'ResponseData', id: pageContentId, data: toBase64(slice) })
    }
    if (activeRequests.has(pageContentId)) {
      activeRequests.delete(pageContentId)
      post({ _tag: 'ResponseFinished', id: pageContentId })
    }
  }

  const teardownSettleWatch = (): void => {
    if (observer !== undefined) {
      observer.disconnect()
      observer = undefined
    }
    if (quietTimer !== undefined) {
      clearTimeout(quietTimer)
      quietTimer = undefined
    }
    if (ceilingTimer !== undefined) {
      clearTimeout(ceilingTimer)
      ceilingTimer = undefined
    }
    // Post-settlement the page-content stream still touches `activeRequests`;
    // detach the signal so those touches can't re-arm a torn-down watch.
    signalActivity = noopActivity
  }

  // Settle: tear the watch down *first* (so the page-content stream below can't
  // re-arm anything via `activeRequests`), then snapshot.
  const settleNow = (): void => {
    if (pageSnapshotEmitted) return
    teardownSettleWatch()
    emitPageLoaded()
  }

  const onQuietElapsed = (): void => {
    quietTimer = undefined
    if (pageSnapshotEmitted) return
    // Only settle if the network is also idle. Otherwise stay disarmed: the next
    // request terminal or DOM mutation re-arms via `signalActivity`, and the
    // ceiling is the ultimate backstop for a page that never goes idle.
    if (activeRequests.size === 0) {
      settleNow()
    }
  }

  // Debounce: (re)start the quiet window. Called on every DOM mutation and every
  // request start/terminal, so the window measures continuous quiet.
  const armQuietTimer = (): void => {
    if (pageSnapshotEmitted) return
    if (quietTimer !== undefined) clearTimeout(quietTimer)
    quietTimer = setTimeout(onQuietElapsed, quietWindowMs)
  }

  const startSettleWatch = (): void => {
    if (settleWatchStarted || pageSnapshotEmitted) return
    settleWatchStarted = true
    // Requests now re-arm the quiet window (via `trackRequest*`).
    signalActivity = armQuietTimer
    observer = new MutationObserver(() => {
      armQuietTimer()
    })
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
    ceilingTimer = setTimeout(settleNow, maxWaitMs)
    armQuietTimer()
  }
  win.addEventListener('load', startSettleWatch)

  // Host→Web messages arrive on the multiplexed `BRIDGE_EVENT` channel;
  // demux by `_tag`. Unrecognized tags (other slices' traffic, our own
  // echo from the broadcast bus) are dropped. Only Tauri IPC can invoke
  // this listener, so page scripts can't spoof inbound messages.
  //
  // `CancelSnifferRequest` emits a terminal `Cancelled` so the host can
  // release per-id state without a `ResponseFinished` that won't come.
  // `PageAction` is the single scripted-interaction tag; its `action.kind`
  // selects the in-page effect (`Click` — best-effort
  // `querySelector(...)?.click()`; `Fill` — controlled-input fill). Both are
  // best-effort with no feedback on a miss (the host retries after the next
  // `PageLoaded`). Validation is hand-rolled here (no runtime schemas survive
  // the IIFE bundle) — a malformed envelope is dropped silently.

  /**
   * Framework-aware value write. Frameworks like Angular and React track
   * a controlled input's value by overriding the `value` property on the
   * element *instance*, so a plain `el.value = …` is swallowed and the
   * framework's model never updates. Writing through the setter defined
   * on the element's own *prototype* (`HTMLInputElement.prototype`, …)
   * bypasses the instance override, and dispatching bubbling
   * `input`/`change` events then drives the framework's value accessor —
   * the standard controlled-input trick. Best-effort: a target without a
   * usable value setter is left untouched.
   */
  const fillInput = (target: Element, value: string): void => {
    const prototype: unknown = Object.getPrototypeOf(target)
    const descriptor =
      prototype === null || prototype === undefined
        ? undefined
        : Object.getOwnPropertyDescriptor(prototype, 'value')
    // Always invoked via `.call(target, …)` below, so the lost-`this`
    // concern the rule guards against doesn't apply (same as the XHR
    // native-method captures above).
    // oxlint-disable-next-line typescript-eslint/unbound-method
    const nativeSetter = descriptor?.set
    if (typeof nativeSetter === 'function') {
      nativeSetter.call(target, value)
    } else if ('value' in target) {
      target.value = value
    } else {
      return
    }
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const unlistens: Array<(() => void) | Promise<() => void>> = []
  unlistens.push(
    eventBus.listen(BRIDGE_EVENT, ({ payload }) => {
      if (payload === null || typeof payload !== 'object') return
      const msg = payload as Partial<SnifferInboundMessage>
      if (msg._tag === 'CancelSnifferRequest') {
        if (typeof msg.id !== 'string') return
        const wasActive = activeRequests.has(msg.id)
        trackRequestEnd(msg.id)
        if (wasActive) {
          post({ _tag: 'Cancelled', id: msg.id })
        }
        return
      }
      if (msg._tag === 'PageAction') {
        const { action } = msg
        // Envelope shape guard: an object `action` with a non-empty string
        // `querySelector`. `kind` selects the effect below; an unknown kind
        // falls through to the trailing no-op return.
        if (action === undefined || action === null || typeof action !== 'object') return
        if (typeof action.querySelector !== 'string' || action.querySelector.length === 0) return
        const target = document.querySelector(action.querySelector)
        if (target === null) return
        if (action.kind === 'Click') {
          if ('click' in target && typeof target.click === 'function') {
            target.click()
          }
          return
        }
        if (action.kind === 'Fill') {
          if (typeof action.value !== 'string') return
          fillInput(target, action.value)
          return
        }
        return
      }
    })
  )

  winWithState[stateKey] = {
    nativeFetch,
    nativeXHROpen,
    nativeXHRSend,
    activeRequests,
    pageLoadHandler: startSettleWatch,
    teardownSettleWatch,
    unlistens,
  }
  // `logError` is captured for use by future top-level error sinks;
  // referencing it here keeps the local binding from being optimized
  // away by the IIFE bundler.
  void logError
}

export { BRIDGE_EVENT, installSniffer, SNIFFER_STATE_KEY }
export type { InstallSnifferOptions, SnifferInboundMessage, SnifferOutboundMessage, SnifferState }
