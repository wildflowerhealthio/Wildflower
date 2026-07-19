// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the sniffer message wire shape lives in core; tests cast through `Message` at decoded-payload boundaries
// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest's `expect.any` / `expect.objectContaining` / `expect.stringMatching` matchers are typed as `any`; using them in object literals for `objectContaining` is the intended idiom

import {
  PageLoadedMessage,
  RequestErrorMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  ResponseStartMessage,
} from 'browser-sniffer-core'
import { Schema } from 'effect'
import { Logging } from 'effect-messaging-core'
import type { TauriEventApi } from 'effect-messaging-tauri'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  BRIDGE_EVENT,
  installSniffer,
  SNIFFER_STATE_KEY,
  type SnifferState,
} from '../src/install-sniffer.ts'

const { expectDistinct, expectToMultisetEqual } = utilityExpectations(expect)

interface Message {
  readonly _tag: string
  readonly [key: string]: unknown
}

interface TauriEnvelope {
  readonly payload: unknown
}

// Capture the real prototype methods once so each test can reset to them
// before installSniffer captures (potentially mocked) values. We always
// re-assign these back to the prototype, so the bare reference is safe;
// `this` is supplied implicitly via the assignment.
// oxlint-disable-next-line typescript-eslint/unbound-method
const originalXHROpen = XMLHttpRequest.prototype.open
// oxlint-disable-next-line typescript-eslint/unbound-method
const originalXHRSend = XMLHttpRequest.prototype.send
const originalFetch = window.fetch

const getState = (): SnifferState | undefined =>
  (window as unknown as Record<symbol, SnifferState | undefined>)[SNIFFER_STATE_KEY]

const resetShims = (): void => {
  const state = getState()
  if (state !== undefined) {
    window.removeEventListener('load', state.pageLoadHandler)
    // Disconnect the MutationObserver and clear any pending settle timers so a
    // mid-flight watch from one test can't leak a PageLoaded into the next.
    state.teardownSettleWatch()
    for (const entry of state.unlistens) {
      void Promise.resolve(entry).then((unlisten) => {
        unlisten()
      })
    }
    delete (window as unknown as Record<symbol, unknown>)[SNIFFER_STATE_KEY]
  }
  // Always restore originals — installSniffer overrode them whether or not
  // the state slot survived, and per-test mocks may have replaced
  // `XMLHttpRequest.prototype.{open,send}` / `window.fetch` *before* install.
  XMLHttpRequest.prototype.open = originalXHROpen
  XMLHttpRequest.prototype.send = originalXHRSend
  window.fetch = originalFetch
}

// Per-test recorder: every `eventBus.emit(event, payload)` call lands
// in `emits` (the payload is the structured sniffer message), and every
// `eventBus.listen(event, handler)` registers the handler in `listeners`
// so `fireInbound` can poke it from tests. `installSnifferForTest()`
// passes `testEventBus` to `installSniffer`.
let emits: Message[] = []
let listeners = new Map<string, (env: TauriEnvelope) => void>()
let testEventBus: TauriEventApi

const setupEnv = (): (() => Message[]) => {
  emits = []
  listeners = new Map()
  testEventBus = {
    emit: async (_event, payload): Promise<void> => {
      emits.push(payload as Message)
    },
    listen: async (event, handler): Promise<() => void> => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
  }
  return () => emits
}

const installSnifferForTest = (settle?: { quietWindowMs?: number; maxWaitMs?: number }): void => {
  installSniffer(testEventBus, settle === undefined ? undefined : { settle })
}

const fireInbound = (event: string, payload: unknown): void => {
  const handler = listeners.get(event)
  expect(handler, `no Tauri listener registered for ${event}`).toBeDefined()
  handler?.({ payload })
}

// The sniffer's fetch string branch wraps the input in `new Request(input,
// init)`. A real browser WebView resolves a relative string against the
// document base there; jsdom's runtime `Request` (undici) instead throws
// `Failed to parse URL`. So to exercise a relative-URL fetch end-to-end we
// make `Request` browser-faithful for the callback — resolve string inputs
// against `window.location.href` — and restore it afterward.
const withBrowserRequest = async (fn: () => Promise<void>): Promise<void> => {
  const OriginalRequest = globalThis.Request
  class BrowserRequest extends OriginalRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, window.location.href).href : input, init)
    }
  }
  globalThis.Request = BrowserRequest
  try {
    await fn()
  } finally {
    globalThis.Request = OriginalRequest
  }
}

const withTag = (msgs: Message[], tag: string): Message[] => msgs.filter((m) => m._tag === tag)

const cancelRequest = (id: string): void => {
  fireInbound(BRIDGE_EVENT, { _tag: 'CancelSnifferRequest', id })
}

// Domain-event schemas.
const decodeLog = Schema.decodeUnknownSync(Schema.typeSchema(Logging.LogMessage))
const decodeResponseStart = Schema.decodeUnknownSync(Schema.typeSchema(ResponseStartMessage))
const decodeResponseData = Schema.decodeUnknownSync(Schema.typeSchema(ResponseDataMessage))
const decodeResponseFinished = Schema.decodeUnknownSync(Schema.typeSchema(ResponseFinishedMessage))
const decodeRequestError = Schema.decodeUnknownSync(Schema.typeSchema(RequestErrorMessage))
const decodePageLoaded = Schema.decodeUnknownSync(Schema.typeSchema(PageLoadedMessage))
const decodeByTag: Record<string, (msg: unknown) => unknown> = {
  Log: decodeLog,
  ResponseStart: decodeResponseStart,
  ResponseData: decodeResponseData,
  ResponseFinished: decodeResponseFinished,
  RequestError: decodeRequestError,
  PageLoaded: decodePageLoaded,
}

const validateMessages = (msgs: Message[]): void => {
  for (const msg of msgs) {
    const decode = decodeByTag[msg._tag]
    expect(decode, `unknown _tag ${msg._tag}`).toBeDefined()
    expect(() => decode(msg)).not.toThrow()
  }
}

const fromBase64 = (b64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))

/**
 * Reassemble the UTF-8 text streamed under a synthetic id (the
 * `pageContentId` from a `PageLoaded` message, typically). Decodes
 * each `ResponseData.data` base64 chunk and concatenates the bytes
 * before decoding once — straddling non-BMP code points stays
 * byte-correct.
 */
const reassembleStream = (msgs: Message[], id: string): string => {
  const chunks = msgs
    .filter(
      (m): m is Message & { id: string; data: string } =>
        m._tag === 'ResponseData' && (m as { id?: unknown }).id === id
    )
    .map((m) => Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0)))
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(combined)
}

describe('fetch shim', () => {
  let getMessages: () => Message[]

  beforeEach(() => {
    resetShims()
    getMessages = setupEnv()
  })

  afterEach(resetShims)

  test('should preserve the original fetch in the sniffer state', () => {
    const original = window.fetch
    installSnifferForTest()
    // `win.fetch.bind(win)` returns a new function reference, so
    // identity-equality with `original` won't hold. The behaviorally
    // relevant assertions are that the slot is populated and that
    // `window.fetch` was swapped for the shim.
    expect(getState()).toEqual(expect.objectContaining({ nativeFetch: expect.any(Function) }))
    expect(window.fetch).not.toBe(original)
  })

  test('should log shim installation', () => {
    installSnifferForTest()
    expect(getMessages()).toContainEqual({
      _tag: 'Log',
      level: 'info',
      payload: ['Shimming fetch'],
    })
  })

  test('should forward arbitrary status + statusText to ResponseStart', async () => {
    // `Response`'s constructor rejects status codes outside [200, 599] and
    // requires a `null` body for 204/205/304; using `null` covers both
    // constraints. `statusText` accepts any printable ASCII; CR/LF is
    // stripped (it would corrupt the HTTP reason-phrase).
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 200, max: 599 }),
        fc.string().map((s) => s.replace(/[\r\n]/g, '')),
        async (status, statusText) => {
          resetShims()
          const getMs = setupEnv()
          window.fetch = vi.fn().mockResolvedValue(new Response(null, { status, statusText }))
          installSnifferForTest()
          await window.fetch('https://test.example/status')

          expect(withTag(getMs(), 'ResponseStart')).toEqual([
            expect.objectContaining({ _tag: 'ResponseStart', status, statusText }),
          ])
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('should capture arbitrary header records on ResponseStart', async () => {
    // Header names: a small pool of realistic lowercase identifiers (Fetch
    // normalizes to lowercase, so expected keys are already lowercase).
    // Values: printable strings with CR/LF stripped — those would break the
    // underlying Headers serialization.
    const headerNameArb = fc.constantFrom(
      'content-type',
      'content-length',
      'cache-control',
      'accept',
      'authorization',
      'x-custom',
      'x-trace-id'
    )
    // Strip CR/LF (would corrupt Headers serialization) AND leading/trailing
    // whitespace (the Headers normalizer trims it, so the round-trip wouldn't
    // preserve those bytes).
    const headerValueArb = fc.string().map((s) => s.replace(/[\r\n]/g, '').trim())
    await fc.assert(
      fc.asyncProperty(fc.dictionary(headerNameArb, headerValueArb), async (headersInput) => {
        resetShims()
        const getMs = setupEnv()
        window.fetch = vi
          .fn()
          .mockResolvedValue(new Response('ok', { status: 200, headers: headersInput }))
        installSnifferForTest()
        const res = await window.fetch('https://test.example/headers')
        await res.text()

        const expectedTuples = Object.entries(headersInput).map(([k, v]): [string, string] => [
          k.toLowerCase(),
          v,
        ])
        expect(withTag(getMs(), 'ResponseStart')).toEqual([
          expect.objectContaining({
            _tag: 'ResponseStart',
            headers: expect.arrayContaining(
              expectedTuples.map((pair) => expect.arrayContaining(pair))
            ),
          }),
        ])
        validateMessages(getMs())
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('should handle bodyless responses with immediate ResponseFinished', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    installSnifferForTest()
    await window.fetch('https://test.example/empty')

    // No ResponseData emitted between start and finish for a null body.
    const lifecycle = getMessages()
      .filter((m) => m._tag !== 'Log')
      .map((m) => m._tag)
    expect(lifecycle).toEqual(['ResponseStart', 'ResponseFinished'])
  })

  test('should post RequestError and re-throw on fetch network error', async () => {
    window.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    installSnifferForTest()

    await expect(window.fetch('https://test.example/fail')).rejects.toThrow('network down')
    expect(withTag(getMessages(), 'RequestError')).toEqual([
      expect.objectContaining({
        _tag: 'RequestError',
        url: 'https://test.example/fail',
        message: 'network down',
      }),
    ])
    validateMessages(getMessages())
  })

  test('should handle Request object input', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response(null))
    installSnifferForTest()
    await window.fetch(new Request('https://test.example/req-obj'))

    expect(withTag(getMessages(), 'ResponseStart')).toEqual([
      expect.objectContaining({ url: 'https://test.example/req-obj' }),
    ])
  })

  test('resolves a relative string URL to absolute in ResponseStart (issue #373)', async () => {
    // A same-origin relative fetch — the common case in real web apps. It
    // must be reported absolute so the downstream `://host…` UrlMatch can
    // match it; a verbatim `/fhir/…` never matches and is silently cancelled.
    await withBrowserRequest(async () => {
      window.fetch = vi.fn().mockResolvedValue(new Response(null))
      installSnifferForTest()
      await window.fetch('/fhir/Patient/1')

      const expected = new URL('/fhir/Patient/1', window.location.href).href
      expect(expected).toMatch(/^https?:\/\//)
      expect(withTag(getMessages(), 'ResponseStart')).toEqual([
        expect.objectContaining({ url: expected }),
      ])
    })
  })

  test('leaves an already-absolute string URL byte-identical (idempotent normalization)', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response(null))
    installSnifferForTest()
    await window.fetch('https://api.example.com/fhir/Patient/1?_format=json')

    expect(withTag(getMessages(), 'ResponseStart')).toEqual([
      expect.objectContaining({ url: 'https://api.example.com/fhir/Patient/1?_format=json' }),
    ])
  })

  test('passes a data: URL through unchanged (exotic scheme, no throw)', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response(null))
    installSnifferForTest()
    await window.fetch('data:text/plain,hello')

    expect(withTag(getMessages(), 'ResponseStart')).toEqual([
      expect.objectContaining({ url: 'data:text/plain,hello' }),
    ])
  })

  test('reports a relative URL as absolute on a pre-response fetch error (issue #373)', async () => {
    await withBrowserRequest(async () => {
      window.fetch = vi.fn().mockRejectedValue(new Error('offline'))
      installSnifferForTest()
      const expected = new URL('/fhir/Patient/1', window.location.href).href

      await expect(window.fetch('/fhir/Patient/1')).rejects.toThrow('offline')
      expect(withTag(getMessages(), 'ResponseStart')).toEqual([
        expect.objectContaining({ url: expected, status: 0 }),
      ])
      expect(withTag(getMessages(), 'RequestError')).toEqual([
        expect.objectContaining({ url: expected, message: 'offline' }),
      ])
      validateMessages(getMessages())
    })
  })

  test('should produce schema-valid messages for any body', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'grapheme' }), async (body) => {
        resetShims()
        const getMs = setupEnv()
        window.fetch = vi.fn().mockResolvedValue(new Response(body))
        installSnifferForTest()

        const res = await window.fetch('https://test.example/validate')
        await res.text()

        validateMessages(getMs())
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('should reconstruct original body from base64-encoded ResponseData chunks', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'grapheme' }), async (body) => {
        resetShims()
        const getMs = setupEnv()
        window.fetch = vi.fn().mockResolvedValue(new Response(body))
        installSnifferForTest()

        const res = await window.fetch('https://test.example/data')
        await res.text()

        const datas = withTag(getMs(), 'ResponseData')
        const reconstructed = datas.map((m) => fromBase64(m.data as string)).join('')
        expect(reconstructed).toBe(body)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('should report the request URL (normalized to absolute) in ResponseStart', async () => {
    await fc.assert(
      fc.asyncProperty(fc.webUrl(), async (url) => {
        resetShims()
        const getMs = setupEnv()
        window.fetch = vi.fn().mockResolvedValue(new Response(null))
        installSnifferForTest()
        await window.fetch(url)

        // The sniffer resolves the input against `location.href` (issue
        // #373). `fc.webUrl()` emits already-absolute URLs, so this is the
        // idempotent case — but `new URL().href` still canonicalizes (a
        // host-only URL gains a trailing `/`), so compare against that form.
        const expected = new URL(url, window.location.href).href
        expect(withTag(getMs(), 'ResponseStart')).toEqual([
          expect.objectContaining({ url: expected }),
        ])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('should post exactly one ResponseStart and one ResponseFinished per request', async () => {
    await fc.assert(
      fc.asyncProperty(fc.webUrl(), fc.string({ unit: 'grapheme' }), async (url, body) => {
        resetShims()
        const getMs = setupEnv()
        window.fetch = vi.fn().mockResolvedValue(new Response(body))
        installSnifferForTest()
        const res = await window.fetch(url)
        await res.text()

        const msgs = getMs().filter((m) => m._tag !== 'Log')
        expect(withTag(msgs, 'ResponseStart')).toHaveLength(1)
        expect(withTag(msgs, 'ResponseFinished')).toHaveLength(1)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('should use a consistent ID across all messages for one request', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'grapheme' }), async (body) => {
        resetShims()
        const getMs = setupEnv()
        window.fetch = vi.fn().mockResolvedValue(new Response(body))
        installSnifferForTest()
        const res = await window.fetch('https://test.example')
        await res.text()

        const msgs = getMs().filter((m) => m._tag !== 'Log')
        const ids = new Set(msgs.map((m) => m['id']))
        expect(ids.size).toBe(1)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('should correctly correlate concurrent fetch requests with distinct IDs', async () => {
    let resolveA!: (v: Response) => void
    let resolveB!: (v: Response) => void
    const promiseA = new Promise<Response>((r) => {
      resolveA = r
    })
    const promiseB = new Promise<Response>((r) => {
      resolveB = r
    })

    let callCount = 0
    window.fetch = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return promiseA
      return promiseB
    })
    installSnifferForTest()

    const fetchA = window.fetch('https://test.example/a')
    const fetchB = window.fetch('https://test.example/b')

    resolveB(new Response('body-b', { status: 200 }))
    resolveA(new Response('body-a', { status: 200 }))

    const resA = await fetchA
    const resB = await fetchB
    await resA.text()
    await resB.text()

    const starts = withTag(getMessages(), 'ResponseStart')
    // Resolution order — `resolveB` fires before `resolveA` — drives the
    // order of `ResponseStart` events, so the URL list is unordered.
    expect(starts).toHaveLength(2)
    expectToMultisetEqual(
      starts.map((s) => s.url as string),
      ['https://test.example/a', 'https://test.example/b']
    )

    const ids = starts.map((s) => s.id as string)
    expectDistinct(ids)
    expectToMultisetEqual(
      withTag(getMessages(), 'ResponseFinished').map((f) => f.id as string),
      ids
    )

    const idSet = new Set(ids)
    for (const d of withTag(getMessages(), 'ResponseData')) {
      expect(idSet.has(d.id as string)).toBe(true)
    }
    validateMessages(getMessages())
  })

  test('should correlate N concurrent fetches under arbitrary resolution order', async () => {
    // `fc.scheduler()` controls the resolution order of the scheduled
    // mock responses; each property run re-shuffles the order. Even
    // with up to ~8 in-flight requests resolving in any interleaving,
    // every request must surface a ResponseStart with its own URL,
    // a distinct id, and matching ResponseFinished + ResponseData ids.
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(fc.tuple(fc.webUrl(), fc.string({ unit: 'grapheme' })), {
          minLength: 2,
          maxLength: 8,
        }),
        async (s, requests) => {
          resetShims()
          const getMs = setupEnv()
          const scheduledResponses = requests.map(([, body]) =>
            s.schedule(Promise.resolve(new Response(body)))
          )
          let callIdx = 0
          window.fetch = vi.fn().mockImplementation(() => scheduledResponses[callIdx++])
          installSnifferForTest()

          const fetched = requests.map(([url]) =>
            window.fetch(url).then(async (r) => {
              await r.text()
            })
          )
          await s.waitFor(Promise.all(fetched))

          const starts = withTag(getMs(), 'ResponseStart')
          expect(starts).toHaveLength(requests.length)
          expectToMultisetEqual(
            starts.map((s_) => s_.url as string),
            // Reported URLs are normalized to absolute (issue #373); compare
            // against the same canonical form the sniffer applies.
            requests.map(([url]) => new URL(url, window.location.href).href)
          )

          const ids = starts.map((s_) => s_.id as string)
          expectDistinct(ids)
          expectToMultisetEqual(
            withTag(getMs(), 'ResponseFinished').map((f) => f.id as string),
            ids
          )

          const idSet = new Set(ids)
          for (const d of withTag(getMs(), 'ResponseData')) {
            expect(idSet.has(d.id as string)).toBe(true)
          }
          validateMessages(getMs())
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test.each([
    'ipc://localhost/cmd',
    'tauri://localhost/asset',
    'http://ipc.localhost/x',
    'https://tauri.localhost/y',
  ])('does not sniff Tauri-internal fetch %s (handed straight to native)', async (url) => {
    // Tauri's own IPC transport fetches from this same context; the shim
    // must hand those to native unsniffed so they don't re-enter the
    // bridge. The fetch still runs, but emits no Response* observations.
    const native = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    window.fetch = native
    installSnifferForTest()

    const res = await window.fetch(url)
    await res.text()

    expect(native).toHaveBeenCalledTimes(1)
    expect(withTag(getMessages(), 'ResponseStart')).toHaveLength(0)
    expect(withTag(getMessages(), 'ResponseData')).toHaveLength(0)
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(0)
  })

  test('still sniffs ordinary fetches after the internal-URL guard', async () => {
    const native = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    window.fetch = native
    installSnifferForTest()

    await window.fetch('ipc://localhost/cmd')
    await window.fetch('https://api.example.com/things')

    // Only the real external request produced a ResponseStart.
    expect(withTag(getMessages(), 'ResponseStart')).toEqual([
      expect.objectContaining({ _tag: 'ResponseStart', url: 'https://api.example.com/things' }),
    ])
  })

  test('sniffs an external host that merely shares the IPC host as a prefix', async () => {
    // `https://ipc.localhost.evil.example` is a different host than Tauri's
    // `ipc.localhost`; a bare prefix match would mis-classify it as internal
    // and silently skip sniffing. It must be sniffed like any external URL.
    const native = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    window.fetch = native
    installSnifferForTest()

    await window.fetch('https://ipc.localhost.evil.example/x')
    await window.fetch('http://tauri.localhost.attacker.test/y')

    expect(withTag(getMessages(), 'ResponseStart')).toEqual([
      expect.objectContaining({ url: 'https://ipc.localhost.evil.example/x' }),
      expect.objectContaining({ url: 'http://tauri.localhost.attacker.test/y' }),
    ])
  })

  test('probes exotic request inputs via toString() (the Match.orElse fallback)', async () => {
    // A request that is not a string, not a URL, and has no string `url` property
    // falls to the probe's `Match.orElse((r) => r.toString())` branch. Its
    // stringified form is Tauri-internal here, so the fetch must be handed
    // straight to native, unsniffed, with the original input untouched.
    const native = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    window.fetch = native
    installSnifferForTest()

    // Deliberately outside the `RequestInfo | URL` union — the cast models an
    // engine handing the shim an exotic request-like value.
    const exotic = { toString: () => 'ipc://localhost/cmd' } as unknown as Request
    await window.fetch(exotic)

    expect(native).toHaveBeenCalledTimes(1)
    expect(native).toHaveBeenCalledWith(exotic, undefined)
    expect(withTag(getMessages(), 'ResponseStart')).toHaveLength(0)
  })
})

describe('XHR shim', () => {
  let getMessages: () => Message[]

  beforeEach(() => {
    resetShims()
    // Stub the prototype methods BEFORE installSniffer runs so the shim
    // captures the no-op stubs (and the underlying open/send never fires
    // a real network call in jsdom).
    XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
    XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
    getMessages = setupEnv()
  })

  afterEach(resetShims)

  test('should preserve the original open/send in the sniffer state', () => {
    installSnifferForTest()
    expect(getState()).toEqual(
      expect.objectContaining({
        nativeXHROpen: expect.any(Function),
        nativeXHRSend: expect.any(Function),
      })
    )
  })

  test('should log shim installation', () => {
    installSnifferForTest()
    expect(getMessages()).toContainEqual({
      _tag: 'Log',
      level: 'info',
      payload: ['Shimming XMLHttpRequest'],
    })
  })

  test('should defer ResponseStart until response headers are available', () => {
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr')
    xhr.send()

    expect(withTag(getMessages(), 'ResponseStart')).toEqual([])

    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'data', configurable: true })
    xhr.dispatchEvent(new Event('progress'))

    expect(withTag(getMessages(), 'ResponseStart')).toEqual([
      expect.objectContaining({
        url: 'https://test.example/xhr',
        status: 200,
        statusText: 'OK',
      }),
    ])
  })

  test('resolves a relative XHR URL to absolute in ResponseStart (issue #373)', () => {
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', '/fhir/Patient/1')
    xhr.send()

    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'data', configurable: true })
    xhr.dispatchEvent(new Event('progress'))

    const expected = new URL('/fhir/Patient/1', window.location.href).href
    expect(expected).toMatch(/^https?:\/\//)
    expect(withTag(getMessages(), 'ResponseStart')).toEqual([
      expect.objectContaining({ url: expected }),
    ])
  })

  test('reports a relative XHR URL as absolute on the error event (issue #373)', () => {
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', '/fhir/Patient/1')
    xhr.send()
    xhr.dispatchEvent(new Event('error'))

    const expected = new URL('/fhir/Patient/1', window.location.href).href
    expect(withTag(getMessages(), 'RequestError')).toEqual([
      expect.objectContaining({ url: expected, message: 'XMLHttpRequest error' }),
    ])
  })

  test('still classifies a Tauri-internal XHR from the raw URL, not the normalized one', () => {
    // Guard-on-raw: `ipc://localhost/cmd` is absolute already, but the point
    // is that the internal check sees the raw string. It must skip sniffing.
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'ipc://localhost/cmd')
    xhr.send()

    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'ipc', configurable: true })
    xhr.dispatchEvent(new Event('progress'))
    xhr.dispatchEvent(new Event('load'))

    expect(withTag(getMessages(), 'ResponseStart')).toHaveLength(0)
  })

  test('should post ResponseFinished on load with remaining text flushed as base64', () => {
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr')
    xhr.send()

    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'final data', configurable: true })
    xhr.dispatchEvent(new Event('load'))

    expect(withTag(getMessages(), 'ResponseData')).toEqual([
      expect.objectContaining({ data: btoa('final data') }),
    ])
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(1)
  })

  test('should post RequestError on XHR error event', () => {
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr-err')
    xhr.send()

    xhr.dispatchEvent(new Event('error'))

    expect(withTag(getMessages(), 'RequestError')).toEqual([
      expect.objectContaining({
        url: 'https://test.example/xhr-err',
        message: 'XMLHttpRequest error',
      }),
    ])
    validateMessages(getMessages())
  })

  test('should post RequestError (not ResponseFinished) on abort', () => {
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr-abort')
    xhr.send()

    xhr.dispatchEvent(new Event('abort'))

    // An aborted request has a partial body: emitting `ResponseFinished`
    // would hand that truncated payload to `entity.parse` as if complete.
    // The terminal is a `RequestError` instead, preceded by a synthetic
    // `ResponseStart` (abort before headers).
    expect(withTag(getMessages(), 'ResponseFinished')).toEqual([])
    expect(withTag(getMessages(), 'RequestError')).toEqual([
      expect.objectContaining({
        url: 'https://test.example/xhr-abort',
        message: 'XMLHttpRequest aborted',
      }),
    ])
    validateMessages(getMessages())
  })

  test('emits a synthetic ResponseStart {status:0, headers:[]} before RequestError when error fires before headers', () => {
    // A network-level XHR failure fires `error` with no prior `progress`/`load`,
    // so no `ResponseStart` was ever posted. The shim must synthesize one — with
    // `status: 0` and empty headers (the XHR state after a network error) —
    // mirroring the fetch pre-response path, so the host's `RequestError` handler
    // finds a tracked response instead of dropping the failure with a WARN.
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/pre-headers-error')
    xhr.send()

    xhr.dispatchEvent(new Event('error'))

    const lifecycle = getMessages()
      .filter((m) => m._tag !== 'Log')
      .map((m) => m._tag)
    expect(lifecycle).toEqual(['ResponseStart', 'RequestError'])
    expect(withTag(getMessages(), 'ResponseStart')).toEqual([
      expect.objectContaining({
        _tag: 'ResponseStart',
        url: 'https://test.example/pre-headers-error',
        status: 0,
        headers: [],
      }),
    ])
    expect(withTag(getMessages(), 'RequestError')).toEqual([
      expect.objectContaining({
        url: 'https://test.example/pre-headers-error',
        message: 'XMLHttpRequest error',
      }),
    ])
    validateMessages(getMessages())
  })

  test('an in-flight error (after progress delivered bytes) keeps the real Start + data and adds a single RequestError', () => {
    // The connection drops *mid-stream*: `progress` already posted a
    // `ResponseStart` with the real `status`/headers and flushed a
    // `ResponseData` chunk, then `error` fires. `ensureStartSent` is
    // idempotent (a `startSent` flag), so the error must NOT synthesize a
    // second (`status: 0`) Start — the real Start and the partial body stand,
    // and the error appends exactly one terminal.
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/mid-error')
    xhr.send()

    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'partial', configurable: true })
    xhr.dispatchEvent(new Event('progress'))

    xhr.dispatchEvent(new Event('error'))

    // Exactly one Start, carrying the real 200 status (not the synthetic 0 of a
    // before-headers error), the partial chunk survives, one terminal, no
    // ResponseFinished (the body was never complete).
    const lifecycle = getMessages()
      .filter((m) => m._tag !== 'Log')
      .map((m) => m._tag)
    expect(lifecycle).toEqual(['ResponseStart', 'ResponseData', 'RequestError'])
    expect(withTag(getMessages(), 'ResponseStart')).toEqual([
      expect.objectContaining({ status: 200, statusText: 'OK' }),
    ])
    expect(withTag(getMessages(), 'ResponseData')).toEqual([
      expect.objectContaining({ data: btoa('partial') }),
    ])
    expect(withTag(getMessages(), 'ResponseFinished')).toEqual([])
    expect(withTag(getMessages(), 'RequestError')).toEqual([
      expect.objectContaining({ message: 'XMLHttpRequest error' }),
    ])
    validateMessages(getMessages())
  })

  test('a reused XHR does not emit a terminal under a stale id when the second send errors', () => {
    // XHR instances are reusable: `open()` rotates the id and each `send()` adds
    // fresh `error`/`abort` listeners. A `{ once: true }` listener is only removed
    // after it fires, so send #1's listeners (send #1 succeeded, they never fired)
    // are still registered during send #2. When send #2 errors, send #1's stale
    // listener fires too — the stale-id guard must keep it from posting a terminal
    // under the first id.
    installSnifferForTest()
    const xhr = new XMLHttpRequest()

    // Send #1 — succeeds via `load`; its error/abort listeners never fire.
    xhr.open('GET', 'https://test.example/first')
    xhr.send()
    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'first', configurable: true })
    xhr.dispatchEvent(new Event('load'))

    const firstId = withTag(getMessages(), 'ResponseStart')[0]?.id as string
    expect(withTag(getMessages(), 'ResponseFinished').filter((m) => m.id === firstId)).toHaveLength(
      1
    )

    // Reuse the same instance: `open()` rotates the id, `send()` re-arms listeners.
    xhr.open('GET', 'https://test.example/second')
    xhr.send()
    xhr.dispatchEvent(new Event('error'))

    // Exactly one terminal, under the second id — send #1's stale listener was
    // guarded out, so no RequestError (nor a second ResponseFinished) under the
    // first id.
    const errors = withTag(getMessages(), 'RequestError')
    expect(errors).toHaveLength(1)
    const secondId = errors[0]?.id as string
    expect(secondId).not.toBe(firstId)
    expect(errors.filter((m) => m.id === firstId)).toEqual([])
    expect(withTag(getMessages(), 'ResponseFinished').filter((m) => m.id === secondId)).toEqual([])
    validateMessages(getMessages())
  })

  test('should produce schema-valid messages for XHR lifecycle', () => {
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr')
    xhr.send()

    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'hello', configurable: true })
    xhr.dispatchEvent(new Event('load'))

    validateMessages(getMessages())
  })

  test('should capture incremental responseText slices as base64-encoded ResponseData', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }), { minLength: 1 }), (parts) => {
        resetShims()
        XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
        XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
        const getMs = setupEnv()
        installSnifferForTest()
        const xhr = new XMLHttpRequest()
        xhr.open('GET', 'https://test.example/xhr')
        xhr.send()

        let accumulated = ''
        Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
        Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
        for (const part of parts) {
          accumulated += part
          Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
          Object.defineProperty(xhr, 'responseText', { value: accumulated, configurable: true })
          xhr.dispatchEvent(new Event('progress'))
        }

        const datas = withTag(getMs(), 'ResponseData')
        expect(datas.map((m) => fromBase64(m.data as string))).toEqual(parts)
        expect(datas.map((m) => fromBase64(m.data as string)).join('')).toBe(accumulated)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('should guard against stale listeners when XHR is reused', () => {
    installSnifferForTest()
    const xhr = new XMLHttpRequest()

    xhr.open('GET', 'https://test.example/first')
    xhr.send()
    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'first', configurable: true })
    xhr.dispatchEvent(new Event('progress'))

    const firstDataCount = withTag(getMessages(), 'ResponseData').length

    xhr.open('GET', 'https://test.example/second')
    xhr.send()

    Object.defineProperty(xhr, 'responseText', { value: 'second', configurable: true })
    xhr.dispatchEvent(new Event('progress'))

    const starts = withTag(getMessages(), 'ResponseStart')
    expect(starts).toHaveLength(2)
    // The second `open()` rotates the id, so only the latest start's id
    // should appear in any data emitted *after* that rotation.
    expect(withTag(getMessages(), 'ResponseData').slice(firstDataCount)).toEqual([
      expect.objectContaining({ id: starts[1]?.id }),
    ])
  })

  test('does not sniff a Tauri-internal XHR (send runs natively, emits nothing)', () => {
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'ipc://localhost/cmd')
    xhr.send()

    // The internal request short-circuits in `send` before any listeners
    // are attached, so even a full response lifecycle emits nothing.
    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'ipc payload', configurable: true })
    xhr.dispatchEvent(new Event('progress'))
    xhr.dispatchEvent(new Event('load'))

    expect(withTag(getMessages(), 'ResponseStart')).toHaveLength(0)
    expect(withTag(getMessages(), 'ResponseData')).toHaveLength(0)
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(0)
  })
})

describe('CancelSnifferRequest (host→web bridge message)', () => {
  let getMessages: () => Message[]

  beforeEach(() => {
    resetShims()
    XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
    XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
    getMessages = setupEnv()
  })

  afterEach(resetShims)

  test('should register a single multiplexed Tauri listener on install', () => {
    installSnifferForTest()
    // One unlisten for the single `BRIDGE_EVENT` channel; inbound tags
    // (`PageAction`, `CancelSnifferRequest`) demux by the payload's `_tag`.
    expect(getState()?.unlistens).toHaveLength(1)
    expect(listeners.has(BRIDGE_EVENT)).toBe(true)
  })

  test('should stop posting ResponseData and ResponseFinished after cancellation (fetch)', async () => {
    let enqueueChunk!: (chunk: string) => void
    let closeStream!: () => void
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        enqueueChunk = (chunk: string): void => controller.enqueue(new TextEncoder().encode(chunk))
        closeStream = (): void => {
          controller.close()
        }
      },
    })
    window.fetch = vi.fn().mockResolvedValue(new Response(stream))
    installSnifferForTest()

    const res = await window.fetch('https://test.example/cancel')
    const reader = res.body!.getReader()

    enqueueChunk('first')
    await reader.read()
    expect(withTag(getMessages(), 'ResponseData')).toHaveLength(1)

    const requestId = withTag(getMessages(), 'ResponseStart')[0]?.id as string
    cancelRequest(requestId)

    enqueueChunk('second')
    await reader.read()
    // The post-cancel chunk does not produce a new ResponseData…
    expect(withTag(getMessages(), 'ResponseData')).toHaveLength(1)

    closeStream()
    await reader.read()
    // …and stream close after cancel does not fire ResponseFinished.
    expect(withTag(getMessages(), 'ResponseFinished')).toEqual([])
  })

  test('should stop posting data after cancellation (XHR)', () => {
    installSnifferForTest()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/cancel-xhr')
    xhr.send()

    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'first', configurable: true })
    xhr.dispatchEvent(new Event('progress'))

    const requestId = withTag(getMessages(), 'ResponseStart')[0]?.id as string
    expect(withTag(getMessages(), 'ResponseData')).toHaveLength(1)

    cancelRequest(requestId)

    Object.defineProperty(xhr, 'responseText', { value: 'first more', configurable: true })
    xhr.dispatchEvent(new Event('progress'))
    expect(withTag(getMessages(), 'ResponseData')).toHaveLength(1)

    xhr.dispatchEvent(new Event('load'))
    expect(withTag(getMessages(), 'ResponseFinished')).toEqual([])
  })

  test('should not mutate the active-set on malformed CancelSnifferRequest payloads', () => {
    installSnifferForTest()
    // Wrong tag in payload (Tauri delivers per-tag, but defensive shape
    // check still rejects).
    fireInbound(BRIDGE_EVENT, { _tag: 'Other' })
    // Missing id.
    fireInbound(BRIDGE_EVENT, { _tag: 'CancelSnifferRequest' })
    expect(getState()?.activeRequests).toEqual(new Set())
  })
})

describe('PageAction: Click (host→web bridge message)', () => {
  // Remember the initial body so each test can scribble on it and the next
  // one starts from a clean slate.
  const initialBodyHtml = document.body.innerHTML

  beforeEach(() => {
    resetShims()
    XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
    XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
    document.body.innerHTML = initialBodyHtml
    setupEnv()
  })

  afterEach(resetShims)

  test('clicks the element matched by the Click action querySelector', () => {
    const button = document.createElement('button')
    button.id = 'go'
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    document.body.replaceChildren(button)
    installSnifferForTest()

    fireInbound(BRIDGE_EVENT, {
      _tag: 'PageAction',
      action: { kind: 'Click', querySelector: '#go' },
    })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  test('silently no-ops when the selector matches no element', () => {
    installSnifferForTest()
    expect(() =>
      fireInbound(BRIDGE_EVENT, {
        _tag: 'PageAction',
        action: { kind: 'Click', querySelector: '#missing' },
      })
    ).not.toThrow()
  })

  test('rejects an empty querySelector', () => {
    const button = document.createElement('button')
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    document.body.replaceChildren(button)
    installSnifferForTest()

    fireInbound(BRIDGE_EVENT, { _tag: 'PageAction', action: { kind: 'Click', querySelector: '' } })
    expect(clicked).not.toHaveBeenCalled()
  })
})

describe('PageAction: Fill (host→web bridge message)', () => {
  const initialBodyHtml = document.body.innerHTML

  beforeEach(() => {
    resetShims()
    XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
    XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
    document.body.innerHTML = initialBodyHtml
    setupEnv()
  })

  afterEach(resetShims)

  test('sets the value and dispatches bubbling input/change events', () => {
    const input = document.createElement('input')
    input.id = 'username'
    const onInput = vi.fn()
    const onChange = vi.fn()
    input.addEventListener('input', onInput)
    input.addEventListener('change', onChange)
    document.body.replaceChildren(input)
    installSnifferForTest()

    fireInbound(BRIDGE_EVENT, {
      _tag: 'PageAction',
      action: { kind: 'Fill', querySelector: '#username', value: 'alice' },
    })

    expect(input.value).toBe('alice')
    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
    // Events bubble so a delegated framework listener on an ancestor sees them.
    expect(onInput.mock.calls[0]?.[0]?.bubbles).toBe(true)
  })

  test('writes through the prototype setter, bypassing an instance-level override (controlled-input trick)', () => {
    const input = document.createElement('input')
    input.id = 'password'
    // Simulate a framework (Angular/React) that shadows the value setter on
    // the element instance: a plain `el.value = …` would hit this no-op.
    let instanceSetterCalls = 0
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () =>
        // Read back what the prototype setter stored.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.get?.call(input),
      set: () => {
        instanceSetterCalls += 1
      },
    })
    document.body.replaceChildren(input)
    installSnifferForTest()

    fireInbound(BRIDGE_EVENT, {
      _tag: 'PageAction',
      action: { kind: 'Fill', querySelector: '#password', value: 's3cret' },
    })

    // The instance override was bypassed; the prototype setter ran.
    expect(instanceSetterCalls).toBe(0)
    expect(input.value).toBe('s3cret')
  })

  test('allows an empty-string value (clearing a field)', () => {
    const input = document.createElement('input')
    input.id = 'clearme'
    input.value = 'preset'
    document.body.replaceChildren(input)
    installSnifferForTest()

    fireInbound(BRIDGE_EVENT, {
      _tag: 'PageAction',
      action: { kind: 'Fill', querySelector: '#clearme', value: '' },
    })
    expect(input.value).toBe('')
  })

  test('silently no-ops when the selector matches no element', () => {
    installSnifferForTest()
    expect(() =>
      fireInbound(BRIDGE_EVENT, {
        _tag: 'PageAction',
        action: { kind: 'Fill', querySelector: '#missing', value: 'x' },
      })
    ).not.toThrow()
  })

  test('rejects an empty querySelector', () => {
    const input = document.createElement('input')
    const onInput = vi.fn()
    input.addEventListener('input', onInput)
    document.body.replaceChildren(input)
    installSnifferForTest()

    fireInbound(BRIDGE_EVENT, {
      _tag: 'PageAction',
      action: { kind: 'Fill', querySelector: '', value: 'x' },
    })
    expect(onInput).not.toHaveBeenCalled()
  })

  test('rejects a non-string value', () => {
    const input = document.createElement('input')
    input.id = 'novalue'
    input.value = 'unchanged'
    const onInput = vi.fn()
    input.addEventListener('input', onInput)
    document.body.replaceChildren(input)
    installSnifferForTest()

    // A malformed payload (value not a string) is dropped defensively.
    fireInbound(BRIDGE_EVENT, {
      _tag: 'PageAction',
      action: { kind: 'Fill', querySelector: '#novalue', value: 42 as unknown as string },
    })
    expect(input.value).toBe('unchanged')
    expect(onInput).not.toHaveBeenCalled()
  })
})

describe('PageAction: malformed envelope (host→web bridge message)', () => {
  const initialBodyHtml = document.body.innerHTML

  beforeEach(() => {
    resetShims()
    XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
    XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
    document.body.innerHTML = initialBodyHtml
    setupEnv()
  })

  afterEach(resetShims)

  test('drops a PageAction with a missing or non-object action', () => {
    const button = document.createElement('button')
    button.id = 'go'
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    document.body.replaceChildren(button)
    installSnifferForTest()

    // No `action` field, and a non-object `action` — both dropped without throwing.
    expect(() => fireInbound(BRIDGE_EVENT, { _tag: 'PageAction' })).not.toThrow()
    expect(() =>
      fireInbound(BRIDGE_EVENT, { _tag: 'PageAction', action: 'not-an-object' })
    ).not.toThrow()
    expect(clicked).not.toHaveBeenCalled()
  })

  test('drops a PageAction whose action has an unknown kind', () => {
    const input = document.createElement('input')
    input.id = 'field'
    input.value = 'unchanged'
    const onInput = vi.fn()
    input.addEventListener('input', onInput)
    document.body.replaceChildren(input)
    installSnifferForTest()

    // A future kind not yet taught to this build falls through to a no-op.
    fireInbound(BRIDGE_EVENT, {
      _tag: 'PageAction',
      action: { kind: 'Scroll', querySelector: '#field' },
    })
    expect(input.value).toBe('unchanged')
    expect(onInput).not.toHaveBeenCalled()
  })
})

describe('idempotent re-injection (simulating post-navigation re-inject)', () => {
  beforeEach(() => {
    resetShims()
    XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
    XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
    setupEnv()
  })

  afterEach(resetShims)

  test('installs the fetch/XHR shim exactly once across multiple installs', () => {
    installSnifferForTest()
    const shimmedFetchAfterFirst = window.fetch
    const stateAfterFirst = getState()
    expect(stateAfterFirst).toBeDefined()

    installSnifferForTest()
    installSnifferForTest()

    // The shim is captured once: the state slot survives and
    // `window.fetch` is the same reference as after the first install.
    expect(getState()).toBe(stateAfterFirst)
    expect(window.fetch).toBe(shimmedFetchAfterFirst)
  })
})

// --- page-settlement test helpers ---
// Deterministic settle thresholds for the settlement tests. Fake timers make
// the wall-clock cost zero; distinct quiet-window vs ceiling values let a test
// target one or the other unambiguously.
const SETTLE = { quietWindowMs: 100, maxWaitMs: 5000 } as const

// Let any pending MutationObserver callback run (it delivers on a microtask and
// re-arms the quiet window), then push the fake clock forward by `ms` so the
// settle debounce / ceiling timer fires. Requires `vi.useFakeTimers()`.
const advanceSettle = async (ms: number): Promise<void> => {
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(ms)
}

describe('PageLoaded', () => {
  let getMessages: () => Message[]
  // Remember the initial body so each test can scribble on it and the next
  // one starts from a clean slate.
  const initialBodyHtml = document.body.innerHTML

  beforeEach(() => {
    resetShims()
    XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
    XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
    document.body.innerHTML = initialBodyHtml
    getMessages = setupEnv()
    // `PageLoaded` now fires once the page *settles* (a debounced quiet window),
    // not synchronously on `load`; fake timers drive that window deterministically.
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetShims()
    vi.useRealTimers()
  })

  /** Extract the single PageLoaded message and the page-content stream it points to. */
  const pageLoadedAndContent = (msgs: Message[]): { loaded: Message; content: string } => {
    const [loaded] = withTag(msgs, 'PageLoaded')
    if (loaded === undefined) throw new Error('expected one PageLoaded message')
    const pageContentId = loaded.pageContentId as string
    return { loaded, content: reassembleStream(msgs, pageContentId) }
  }

  // Install, fire `load`, and drive the fake clock past the quiet window so a
  // page with a static DOM (set before install) settles and emits PageLoaded.
  const installAndSettle = async (): Promise<void> => {
    installSnifferForTest(SETTLE)
    window.dispatchEvent(new Event('load'))
    await advanceSettle(SETTLE.quietWindowMs)
  }

  test('should post PageLoaded (notification only) with a pageContentId once the page settles', async () => {
    await installAndSettle()

    const loaded = withTag(getMessages(), 'PageLoaded')
    expect(loaded).toEqual([
      expect.objectContaining({
        _tag: 'PageLoaded',
        url: window.location.href,
        pageContentId: expect.stringMatching(/.+/),
      }),
    ])
    // Body moved off PageLoaded onto the streamed Response* triple
    // correlated by pageContentId.
    expect(loaded[0]).not.toHaveProperty('content')
  })

  test('should stream the DOM content through the standard Response* triple', async () => {
    await installAndSettle()

    const msgs = getMessages()
    const [loaded] = withTag(msgs, 'PageLoaded')
    const pageContentId = loaded?.pageContentId as string
    expect(withTag(msgs, 'ResponseStart')).toEqual([
      expect.objectContaining({
        _tag: 'ResponseStart',
        id: pageContentId,
        url: window.location.href,
        status: 200,
        statusText: 'OK',
      }),
    ])
    expect(withTag(msgs, 'ResponseFinished')).toEqual([
      expect.objectContaining({ _tag: 'ResponseFinished', id: pageContentId }),
    ])
    expect(reassembleStream(msgs, pageContentId)).toMatch(/.+/)
  })

  test('should produce schema-valid PageLoaded + Response* messages', async () => {
    await installAndSettle()
    validateMessages(getMessages())
  })

  test('should register a single settle watch across double injection', async () => {
    installSnifferForTest(SETTLE)
    installSnifferForTest(SETTLE)
    window.dispatchEvent(new Event('load'))
    await advanceSettle(SETTLE.quietWindowMs)

    expect(withTag(getMessages(), 'PageLoaded')).toHaveLength(1)
  })

  test('should emit a single PageLoaded even if load fires twice', async () => {
    // A re-fired `load` must not start a second watch (distinct pageContentIds
    // would double-count the page).
    document.body.innerHTML = '<main>ready</main>'
    installSnifferForTest(SETTLE)
    window.dispatchEvent(new Event('load'))
    window.dispatchEvent(new Event('load'))
    await advanceSettle(SETTLE.quietWindowMs)

    expect(withTag(getMessages(), 'PageLoaded')).toHaveLength(1)
  })

  test('should serialize the entire <html>… subtree, including arbitrary body content', async () => {
    document.body.innerHTML = '<p id="x">hello &amp; goodbye</p>'
    await installAndSettle()

    // `&amp;` survives the HTML-escaped round-trip — `Element.outerHTML`
    // entity-encodes for HTML, so the host parses the captured content as
    // HTML without an extra unescape pass.
    const { content } = pageLoadedAndContent(getMessages())
    expect(content).toMatch(/^<html[^>]*>.*<p id="x">hello &amp; goodbye<\/p>.*<\/html>$/s)
  })

  test('should serialize XML-namespaced subtrees (SVG) via HTML rules', async () => {
    // SVG inside an HTML document exercises non-HTML element serialization.
    // `Element.outerHTML` is defined on every Element (incl. SVGElement),
    // so the subtree round-trips with HTML serialization rules (tag close,
    // attributes preserved, namespace declarations may drop). Documents
    // the expectation for hosts that ingest the captured payload as HTML.
    document.body.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="2" r="3"/></svg>'
    await installAndSettle()

    // `<circle>` closes per HTML rules — either self-closing or paired —
    // and jsdom emits one of those two forms; we accept both so a jsdom
    // upgrade doesn't churn the test.
    const { content } = pageLoadedAndContent(getMessages())
    expect(content).toMatch(/<svg[^>]*>.*<circle[^>]*(?:\/>|><\/circle>).*<\/svg>/s)
  })

  test('should capture WebView-wrapped HTML for text/plain documents', async () => {
    // Every WebView engine renders `text/plain` by wrapping it in a
    // `<pre>` inside `<html><body>`; the sniffer runs against *that*
    // DOM, never the raw bytes, so our handler captures the wrapper.
    // We simulate by populating the body — the captured payload is HTML.
    const lines = 'Line 1\nLine 2 with <brackets>\nLine 3'
    const pre = document.createElement('pre')
    pre.textContent = lines
    document.body.replaceChildren(pre)
    await installAndSettle()

    // `<` and `>` come back HTML-entity-encoded inside the <pre>;
    // line breaks survive as literal `\n` in the serialized HTML.
    const { content } = pageLoadedAndContent(getMessages())
    expect(content).toContain('Line 1\nLine 2 with &lt;brackets&gt;\nLine 3')
    validateMessages(getMessages())
  })

  test('should round-trip binary-shaped DOM text via the streamed wire', async () => {
    // The injected sniffer never sees raw bytes — a `Content-Type:
    // application/octet-stream` URL fails to load (no `load` event) or is
    // wrapped by the WebView into an `<img>`/`<embed>` HTML representation.
    // *If* something pathological put raw bytes into the DOM text (e.g.,
    // `\x00\x01…\xff`), the bytes survive `outerHTML` → UTF-8 → base64 →
    // host-side reassembly via `ResponseData` chunks. The reassembled
    // text should preserve high-byte characters.
    const allBytes = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('')
    document.body.textContent = allBytes
    await installAndSettle()

    const msgs = getMessages()
    const { content } = pageLoadedAndContent(msgs)
    // Bytes that have HTML-significant meaning (`<`, `>`, `&`, `\xa0` →
    // `&nbsp;`) get entity-encoded; everything else passes through. Assert
    // one specific high-byte value survives — the `\xff`.
    expect(content).toContain('\xff')
    validateMessages(msgs)
  })
})

describe('page settlement', () => {
  let getMessages: () => Message[]
  const initialBodyHtml = document.body.innerHTML

  beforeEach(() => {
    resetShims()
    XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
    XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
    document.body.innerHTML = initialBodyHtml
    getMessages = setupEnv()
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetShims()
    vi.useRealTimers()
  })

  test('should hold PageLoaded until the quiet window elapses after load', async () => {
    installSnifferForTest(SETTLE)
    window.dispatchEvent(new Event('load'))

    // One tick short of the window: not settled yet.
    await advanceSettle(SETTLE.quietWindowMs - 1)
    expect(withTag(getMessages(), 'PageLoaded')).toHaveLength(0)

    // Crossing the window with a quiet DOM and no in-flight requests settles it.
    await advanceSettle(1)
    expect(withTag(getMessages(), 'PageLoaded')).toHaveLength(1)
  })

  test('should reset the quiet window on each DOM mutation, settling only once mutations stop', async () => {
    installSnifferForTest(SETTLE)
    window.dispatchEvent(new Event('load'))

    // A mutation late in the window re-arms it, so the original deadline passes
    // without a fire.
    await advanceSettle(SETTLE.quietWindowMs - 10)
    document.body.appendChild(document.createElement('div'))
    await advanceSettle(SETTLE.quietWindowMs - 10)
    expect(withTag(getMessages(), 'PageLoaded')).toHaveLength(0)

    // Once the (re-armed) window fully elapses with no further mutations, settle.
    await advanceSettle(10)
    expect(withTag(getMessages(), 'PageLoaded')).toHaveLength(1)
  })

  test('should not settle while a request is in flight, then settle after it terminates', async () => {
    installSnifferForTest(SETTLE)
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/data')
    xhr.send() // in-flight from send()
    window.dispatchEvent(new Event('load'))

    // The DOM is quiet, but an in-flight request blocks settlement past the
    // quiet window (and well before the ceiling).
    await advanceSettle(SETTLE.quietWindowMs * 2)
    expect(withTag(getMessages(), 'PageLoaded')).toHaveLength(0)

    // The request completes; its terminal re-arms the quiet window.
    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'done', configurable: true })
    xhr.dispatchEvent(new Event('load'))

    await advanceSettle(SETTLE.quietWindowMs)
    expect(withTag(getMessages(), 'PageLoaded')).toHaveLength(1)
  })

  test('should force PageLoaded at the ceiling when a request never terminates', async () => {
    // A request that stays in-flight forever (a hung download / long-poll) can
    // never let the quiet window settle; the ceiling is the backstop.
    installSnifferForTest({ quietWindowMs: 100, maxWaitMs: 300 })
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/never')
    xhr.send() // in-flight, never completes
    window.dispatchEvent(new Event('load'))

    // Past the quiet window, the stuck request still blocks settlement.
    await advanceSettle(200)
    expect(withTag(getMessages(), 'PageLoaded')).toHaveLength(0)

    // The ceiling (300ms) forces exactly one PageLoaded regardless.
    await advanceSettle(100)
    expect(withTag(getMessages(), 'PageLoaded')).toHaveLength(1)
  })
})

describe('injection', () => {
  beforeEach(() => {
    resetShims()
    XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
    XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
    setupEnv()
  })

  afterEach(resetShims)

  test('should not double-shim when injected multiple times', () => {
    installSnifferForTest()
    const firstShimmedFetch = window.fetch
    const firstNativeFetch = getState()?.nativeFetch

    installSnifferForTest()

    expect(window.fetch).toBe(firstShimmedFetch)
    expect(getState()?.nativeFetch).toBe(firstNativeFetch)
  })
})

// The IIFE round-trip — `new Function(tauriSnifferBootstrapScript)()` —
// is covered by `tests/bootstrap.test.ts`, which exercises the bundled
// bootstrap end-to-end through a fake `__TAURI__.event` API.
