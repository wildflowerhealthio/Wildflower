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
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import { installSniffer, SNIFFER_STATE_KEY, snifferScript, type SnifferState } from './index.ts'

const { expectDistinct, expectToMultisetEqual } = utilityExpectations(expect)

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (msg: string) => void }
  }
}

interface Message {
  readonly _tag: string
  readonly [key: string]: unknown
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
    window.removeEventListener('message', state.hostMessageHandler)
    delete (window as unknown as Record<symbol, unknown>)[SNIFFER_STATE_KEY]
  }
  // Always restore originals — installSniffer overrode them whether or not
  // the state slot survived, and per-test mocks may have replaced
  // `XMLHttpRequest.prototype.{open,send}` / `window.fetch` *before* install.
  XMLHttpRequest.prototype.open = originalXHROpen
  XMLHttpRequest.prototype.send = originalXHRSend
  window.fetch = originalFetch
}

const setupEnv = (): (() => Message[]) => {
  const postMessage = vi.fn<(data: string) => void>()
  window.ReactNativeWebView = { postMessage }
  return () => postMessage.mock.calls.map(([json]) => JSON.parse(json) as Message)
}

const withTag = (msgs: Message[], tag: string): Message[] => msgs.filter((m) => m._tag === tag)

const cancelRequest = (id: string): void => {
  // Bridge-format Host→Web cancel. The injected sniffer's
  // `message`-event listener decodes by hand (the bridge runtime
  // schemas can't survive `installSniffer.toString()`).
  window.dispatchEvent(
    new MessageEvent('message', { data: JSON.stringify({ _tag: 'CancelSnifferRequest', id }) })
  )
}

// Domain-event schemas (everything except the transport-level `__Ready`).
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
    if (msg._tag === '__Ready') continue
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

describe('handshake', () => {
  let getMessages: () => Message[]

  beforeEach(() => {
    resetShims()
    getMessages = setupEnv()
  })

  afterEach(resetShims)

  test('posts __Ready as the very first message', () => {
    installSniffer()
    const msgs = getMessages()
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs[0]).toEqual({ _tag: '__Ready' })
  })
})

describe('fetch shim', () => {
  let getMessages: () => Message[]

  beforeEach(() => {
    resetShims()
    getMessages = setupEnv()
  })

  afterEach(resetShims)

  test('should preserve the original fetch in the sniffer state', () => {
    const original = window.fetch
    installSniffer()
    // `win.fetch.bind(win)` returns a new function reference, so
    // identity-equality with `original` won't hold. The behaviorally
    // relevant assertions are that the slot is populated and that
    // `window.fetch` was swapped for the shim.
    expect(getState()).toEqual(expect.objectContaining({ nativeFetch: expect.any(Function) }))
    expect(window.fetch).not.toBe(original)
  })

  test('should log shim installation', () => {
    installSniffer()
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
          installSniffer()
          await window.fetch('https://test.example/status')

          expect(withTag(getMs(), 'ResponseStart')).toEqual([
            expect.objectContaining({ _tag: 'ResponseStart', status, statusText }),
          ])
        }
      ),
      { numRuns: numRunsFor(100) }
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
        installSniffer()
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
      { numRuns: numRunsFor(100) }
    )
  })

  test('should handle bodyless responses with immediate ResponseFinished', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    installSniffer()
    await window.fetch('https://test.example/empty')

    // No ResponseData emitted between start and finish for a null body.
    const lifecycle = getMessages()
      .filter((m) => m._tag !== 'Log' && m._tag !== '__Ready')
      .map((m) => m._tag)
    expect(lifecycle).toEqual(['ResponseStart', 'ResponseFinished'])
  })

  test('should post RequestError and re-throw on fetch network error', async () => {
    window.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    installSniffer()

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
    installSniffer()
    await window.fetch(new Request('https://test.example/req-obj'))

    expect(withTag(getMessages(), 'ResponseStart')).toEqual([
      expect.objectContaining({ url: 'https://test.example/req-obj' }),
    ])
  })

  test('should produce schema-valid messages for any body', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'grapheme' }), async (body) => {
        resetShims()
        const getMs = setupEnv()
        window.fetch = vi.fn().mockResolvedValue(new Response(body))
        installSniffer()

        const res = await window.fetch('https://test.example/validate')
        await res.text()

        validateMessages(getMs())
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  test('should reconstruct original body from base64-encoded ResponseData chunks', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'grapheme' }), async (body) => {
        resetShims()
        const getMs = setupEnv()
        window.fetch = vi.fn().mockResolvedValue(new Response(body))
        installSniffer()

        const res = await window.fetch('https://test.example/data')
        await res.text()

        const datas = withTag(getMs(), 'ResponseData')
        const reconstructed = datas.map((m) => fromBase64(m.data as string)).join('')
        expect(reconstructed).toBe(body)
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  test('should pass through the request URL in ResponseStart', async () => {
    await fc.assert(
      fc.asyncProperty(fc.webUrl(), async (url) => {
        resetShims()
        const getMs = setupEnv()
        window.fetch = vi.fn().mockResolvedValue(new Response(null))
        installSniffer()
        await window.fetch(url)

        expect(withTag(getMs(), 'ResponseStart')).toEqual([expect.objectContaining({ url })])
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  test('should post exactly one ResponseStart and one ResponseFinished per request', async () => {
    await fc.assert(
      fc.asyncProperty(fc.webUrl(), fc.string({ unit: 'grapheme' }), async (url, body) => {
        resetShims()
        const getMs = setupEnv()
        window.fetch = vi.fn().mockResolvedValue(new Response(body))
        installSniffer()
        const res = await window.fetch(url)
        await res.text()

        const msgs = getMs().filter((m) => m._tag !== 'Log' && m._tag !== '__Ready')
        expect(withTag(msgs, 'ResponseStart')).toHaveLength(1)
        expect(withTag(msgs, 'ResponseFinished')).toHaveLength(1)
      }),
      { numRuns: numRunsFor(100) }
    )
  })

  test('should use a consistent ID across all messages for one request', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: 'grapheme' }), async (body) => {
        resetShims()
        const getMs = setupEnv()
        window.fetch = vi.fn().mockResolvedValue(new Response(body))
        installSniffer()
        const res = await window.fetch('https://test.example')
        await res.text()

        const msgs = getMs().filter((m) => m._tag !== 'Log' && m._tag !== '__Ready')
        const ids = new Set(msgs.map((m) => m['id']))
        expect(ids.size).toBe(1)
      }),
      { numRuns: numRunsFor(100) }
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
    installSniffer()

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
          installSniffer()

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
            requests.map(([url]) => url)
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
      { numRuns: numRunsFor(100) }
    )
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
    installSniffer()
    expect(getState()).toEqual(
      expect.objectContaining({
        nativeXHROpen: expect.any(Function),
        nativeXHRSend: expect.any(Function),
      })
    )
  })

  test('should log shim installation', () => {
    installSniffer()
    expect(getMessages()).toContainEqual({
      _tag: 'Log',
      level: 'info',
      payload: ['Shimming XMLHttpRequest'],
    })
  })

  test('should defer ResponseStart until response headers are available', () => {
    installSniffer()
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

  test('should post ResponseFinished on load with remaining text flushed as base64', () => {
    installSniffer()
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
    installSniffer()
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

  test('should post ResponseFinished on abort', () => {
    installSniffer()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr')
    xhr.send()

    xhr.dispatchEvent(new Event('abort'))

    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(1)
  })

  test('should produce schema-valid messages for XHR lifecycle', () => {
    installSniffer()
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
        installSniffer()
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
      { numRuns: numRunsFor(100) }
    )
  })

  test('should guard against stale listeners when XHR is reused', () => {
    installSniffer()
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

  test('should register a message-event listener on install', () => {
    installSniffer()
    expect(getState()?.hostMessageHandler).toBeDefined()
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
    installSniffer()

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
    installSniffer()
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

  test('should not mutate the active-set on malformed or unknown inbound payloads', () => {
    installSniffer()
    window.dispatchEvent(new MessageEvent('message', { data: 'not json' }))
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ _tag: 'Other' }) }))
    window.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ _tag: 'CancelSnifferRequest' }) })
    )
    expect(getState()?.activeRequests).toEqual(new Set())
  })

  test('should post a Log message when the inbound _tag is unrecognised', () => {
    installSniffer()
    const before = withTag(getMessages(), 'Log').length
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ _tag: 'Other' }) }))
    const after = withTag(getMessages(), 'Log')
    expect(after.length).toBe(before + 1)
    const last = after[after.length - 1] as Message & {
      level?: unknown
      payload?: readonly unknown[]
    }
    expect(last._tag).toBe('Log')
    expect(last.level).toBe('warn')
    expect(last.payload).toHaveLength(1)
    expect(String(last.payload?.[0])).toContain('Other')
  })
})

describe('Click (host→web bridge message)', () => {
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

  test('clicks the element matched by querySelector', () => {
    const button = document.createElement('button')
    button.id = 'go'
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    document.body.replaceChildren(button)
    installSniffer()

    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ _tag: 'Click', querySelector: '#go' }),
      })
    )
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  test('silently no-ops when the selector matches no element', () => {
    installSniffer()
    expect(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ _tag: 'Click', querySelector: '#missing' }),
        })
      )
    ).not.toThrow()
  })

  test('rejects an empty querySelector', () => {
    const button = document.createElement('button')
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    document.body.replaceChildren(button)
    installSniffer()

    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ _tag: 'Click', querySelector: '' }),
      })
    )
    expect(clicked).not.toHaveBeenCalled()
  })
})

describe('idempotent re-injection (simulating post-navigation re-inject)', () => {
  let getMessages: () => Message[]

  beforeEach(() => {
    resetShims()
    XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
    XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
    getMessages = setupEnv()
  })

  afterEach(resetShims)

  test('posts __Ready on every install but installs the fetch/XHR shim exactly once', () => {
    installSniffer()
    const shimmedFetchAfterFirst = window.fetch
    const stateAfterFirst = getState()
    expect(stateAfterFirst).toBeDefined()

    installSniffer()
    installSniffer()

    // __Ready handshake fires on every install (a re-injection wakes a
    // host that mounted after the original install).
    expect(withTag(getMessages(), '__Ready')).toHaveLength(3)
    // But the shim itself is captured once: the state slot survives and
    // `window.fetch` is the same reference as after the first install.
    expect(getState()).toBe(stateAfterFirst)
    expect(window.fetch).toBe(shimmedFetchAfterFirst)
  })
})

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
  })

  afterEach(resetShims)

  /** Extract the single PageLoaded message and the page-content stream it points to. */
  const pageLoadedAndContent = (msgs: Message[]): { loaded: Message; content: string } => {
    const [loaded] = withTag(msgs, 'PageLoaded')
    if (loaded === undefined) throw new Error('expected one PageLoaded message')
    const pageContentId = loaded.pageContentId as string
    return { loaded, content: reassembleStream(msgs, pageContentId) }
  }

  test('should post PageLoaded (notification only) with a pageContentId on window load event', () => {
    installSniffer()
    window.dispatchEvent(new Event('load'))

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

  test('should stream the DOM content through the standard Response* triple', () => {
    installSniffer()
    window.dispatchEvent(new Event('load'))

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

  test('should produce schema-valid PageLoaded + Response* messages', () => {
    installSniffer()
    window.dispatchEvent(new Event('load'))
    validateMessages(getMessages())
  })

  test('should not register the load listener twice on double injection', () => {
    installSniffer()
    installSniffer()
    window.dispatchEvent(new Event('load'))

    expect(withTag(getMessages(), 'PageLoaded')).toHaveLength(1)
  })

  test('should serialize the entire <html>… subtree, including arbitrary body content', () => {
    document.body.innerHTML = '<p id="x">hello &amp; goodbye</p>'
    installSniffer()
    window.dispatchEvent(new Event('load'))

    // `&amp;` survives the HTML-escaped round-trip — `Element.outerHTML`
    // entity-encodes for HTML, so the host parses the captured content as
    // HTML without an extra unescape pass.
    const { content } = pageLoadedAndContent(getMessages())
    expect(content).toMatch(/^<html[^>]*>.*<p id="x">hello &amp; goodbye<\/p>.*<\/html>$/s)
  })

  test('should serialize XML-namespaced subtrees (SVG) via HTML rules', () => {
    // SVG inside an HTML document exercises non-HTML element serialization.
    // `Element.outerHTML` is defined on every Element (incl. SVGElement),
    // so the subtree round-trips with HTML serialization rules (tag close,
    // attributes preserved, namespace declarations may drop). Documents
    // the expectation for hosts that ingest the captured payload as HTML.
    document.body.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="2" r="3"/></svg>'
    installSniffer()
    window.dispatchEvent(new Event('load'))

    // `<circle>` closes per HTML rules — either self-closing or paired —
    // and jsdom emits one of those two forms; we accept both so a jsdom
    // upgrade doesn't churn the test.
    const { content } = pageLoadedAndContent(getMessages())
    expect(content).toMatch(/<svg[^>]*>.*<circle[^>]*(?:\/>|><\/circle>).*<\/svg>/s)
  })

  test('should capture WebView-wrapped HTML for text/plain documents', () => {
    // RN-WebView (and every other engine) renders `text/plain` by wrapping
    // it in a `<pre>` inside `<html><body>`; the sniffer runs against
    // *that* DOM, never the raw bytes, so our handler captures the wrapper.
    // We simulate by populating the body — the captured payload is HTML.
    const lines = 'Line 1\nLine 2 with <brackets>\nLine 3'
    const pre = document.createElement('pre')
    pre.textContent = lines
    document.body.replaceChildren(pre)
    installSniffer()
    window.dispatchEvent(new Event('load'))

    // `<` and `>` come back HTML-entity-encoded inside the <pre>;
    // line breaks survive as literal `\n` in the serialized HTML.
    const { content } = pageLoadedAndContent(getMessages())
    expect(content).toContain('Line 1\nLine 2 with &lt;brackets&gt;\nLine 3')
    validateMessages(getMessages())
  })

  test('should round-trip binary-shaped DOM text via the streamed wire', () => {
    // The injected sniffer never sees raw bytes — a `Content-Type:
    // application/octet-stream` URL fails to load (no `load` event) or is
    // wrapped by the WebView into an `<img>`/`<embed>` HTML representation.
    // *If* something pathological put raw bytes into the DOM text (e.g.,
    // `\x00\x01…\xff`), the bytes survive `outerHTML` → UTF-8 → base64 →
    // host-side reassembly via `ResponseData` chunks. The reassembled
    // text should preserve high-byte characters.
    const allBytes = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('')
    document.body.textContent = allBytes
    installSniffer()
    window.dispatchEvent(new Event('load'))

    const msgs = getMessages()
    const { content } = pageLoadedAndContent(msgs)
    // Bytes that have HTML-significant meaning (`<`, `>`, `&`, `\xa0` →
    // `&nbsp;`) get entity-encoded; everything else passes through. Assert
    // one specific high-byte value survives — the `\xff`.
    expect(content).toContain('\xff')
    validateMessages(msgs)
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
    installSniffer()
    const firstShimmedFetch = window.fetch
    const firstNativeFetch = getState()?.nativeFetch

    installSniffer()

    expect(window.fetch).toBe(firstShimmedFetch)
    expect(getState()?.nativeFetch).toBe(firstNativeFetch)
  })
})

describe('snifferScript (string form)', () => {
  let getMessages: () => Message[]

  beforeEach(() => {
    resetShims()
    XMLHttpRequest.prototype.open = vi.fn() as XMLHttpRequest['open']
    XMLHttpRequest.prototype.send = vi.fn() as XMLHttpRequest['send']
    getMessages = setupEnv()
  })

  afterEach(resetShims)

  test('round-trips through new Function() and installs the shims', () => {
    // The "real" delivery path: consumers inject `snifferScript` as a string
    // into a WebView. This test exercises that path in-process to guard
    // against `installSniffer.toString()` losing semantic information
    // (closure capture, top-level identifiers, etc).
    // oxlint-disable-next-line eslint/no-implied-eval -- intentional dynamic injection
    new Function(snifferScript)()

    expect(getMessages()[0]).toEqual({ _tag: '__Ready' })
    expect(getState()).toEqual(
      expect.objectContaining({
        nativeFetch: expect.any(Function),
        nativeXHROpen: expect.any(Function),
        nativeXHRSend: expect.any(Function),
        hostMessageHandler: expect.any(Function),
        pageLoadHandler: expect.any(Function),
      })
    )
  })
})
