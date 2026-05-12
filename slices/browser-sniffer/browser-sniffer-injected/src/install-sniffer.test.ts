// oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the sniffer message wire shape lives in core; tests cast through `Message` at decoded-payload boundaries
// oxlint-disable typescript-eslint/require-array-sort-compare -- ID strings are non-empty and a default lexical sort is the intended ordering here
// oxlint-disable eslint/no-unsafe-optional-chaining -- assertions guard length before chained dereference

import {
  LogMessage,
  PageLoadedMessage,
  RequestErrorMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  ResponseStartMessage,
} from 'browser-sniffer-core'
import { Schema } from 'effect'
import * as fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import { installSniffer, SNIFFER_STATE_KEY, snifferScript, type SnifferState } from './index.ts'

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
const decodeLog = Schema.decodeUnknownSync(Schema.typeSchema(LogMessage))
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
    expect(getState()?.nativeFetch).toBe(original)
    expect(window.fetch).not.toBe(original)
  })

  test('should log shim installation', () => {
    installSniffer()
    expect(getMessages()).toContainEqual({ _tag: 'Log', log: 'Shimming fetch' })
  })

  test('should forward arbitrary status + statusText to ResponseStart', async () => {
    // `Response`'s constructor rejects status codes outside [200, 599]; the
    // arbitrary respects that. `statusText` accepts any printable ASCII.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 200, max: 599 }),
        fc.string().map((s) => s.replace(/[\r\n]/g, '')),
        async (status, statusText) => {
          resetShims()
          const getMs = setupEnv()
          window.fetch = vi.fn().mockResolvedValue(new Response('ok', { status, statusText }))
          installSniffer()
          const res = await window.fetch('https://test.example/status')
          await res.text()

          const starts = withTag(getMs(), 'ResponseStart')
          expect(starts).toHaveLength(1)
          expect(starts[0]?.status).toBe(status)
          expect(starts[0]?.statusText).toBe(statusText)
        }
      )
    )
  })

  test('should capture arbitrary header records on ResponseStart', async () => {
    // Header names: a small pool of realistic lowercase identifiers
    // (Fetch normalizes to lowercase, so the round-trip's expected
    // keys are already lowercase). Values: printable strings with
    // CR/LF stripped — those would break the underlying Headers
    // serialization.
    const headerNameArb = fc.constantFrom(
      'content-type',
      'content-length',
      'cache-control',
      'accept',
      'authorization',
      'x-custom',
      'x-trace-id'
    )
    const headerValueArb = fc.string().map((s) => s.replace(/[\r\n]/g, ''))
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

        const starts = withTag(getMs(), 'ResponseStart')
        expect(starts).toHaveLength(1)
        const captured = starts[0]?.headers as Record<string, string>
        for (const [k, v] of Object.entries(headersInput)) {
          expect(captured[k.toLowerCase()]).toBe(v)
        }
        validateMessages(getMs())
      })
    )
  })

  test('should handle bodyless responses with immediate ResponseFinished', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    installSniffer()
    await window.fetch('https://test.example/empty')

    expect(withTag(getMessages(), 'ResponseData')).toHaveLength(0)
    expect(withTag(getMessages(), 'ResponseStart')).toHaveLength(1)
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(1)
  })

  test('should post RequestError and re-throw on fetch network error', async () => {
    window.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    installSniffer()

    await expect(window.fetch('https://test.example/fail')).rejects.toThrow('network down')
    const errors = withTag(getMessages(), 'RequestError')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.url).toBe('https://test.example/fail')
    expect(errors[0]?.message).toBe('network down')
    validateMessages(getMessages())
  })

  test('should handle Request object input', async () => {
    window.fetch = vi.fn().mockResolvedValue(new Response(null))
    installSniffer()
    await window.fetch(new Request('https://test.example/req-obj'))

    const starts = withTag(getMessages(), 'ResponseStart')
    expect(starts[0]?.url).toBe('https://test.example/req-obj')
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
      })
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
      })
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

        const starts = withTag(getMs(), 'ResponseStart')
        expect(starts).toHaveLength(1)
        expect(starts[0]?.url).toBe(url)
      })
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
      })
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
      })
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
    expect(starts).toHaveLength(2)
    const idA = starts.find((s) => s.url === 'https://test.example/a')?.id as string
    const idB = starts.find((s) => s.url === 'https://test.example/b')?.id as string
    expect(idA).not.toBe(idB)

    const finishes = withTag(getMessages(), 'ResponseFinished')
    expect(finishes).toHaveLength(2)
    expect(finishes.map((f) => f.id).toSorted()).toEqual([idA, idB].toSorted())

    const dataMessages = withTag(getMessages(), 'ResponseData')
    for (const d of dataMessages) {
      expect([idA, idB]).toContain(d.id)
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

          const startUrls = starts.map((s_) => s_.url as string).toSorted()
          const expectedUrls = requests.map(([url]) => url).toSorted()
          expect(startUrls).toEqual(expectedUrls)

          const ids = starts.map((s_) => s_.id as string)
          expect(new Set(ids).size).toBe(ids.length)

          const finishes = withTag(getMs(), 'ResponseFinished')
          expect(finishes.map((f) => f.id).toSorted()).toEqual(ids.toSorted())

          for (const d of withTag(getMs(), 'ResponseData')) {
            expect(ids).toContain(d.id)
          }
          validateMessages(getMs())
        }
      )
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
    const state = getState()
    expect(state?.nativeXHROpen).toBeDefined()
    expect(state?.nativeXHRSend).toBeDefined()
  })

  test('should log shim installation', () => {
    installSniffer()
    expect(getMessages()).toContainEqual({ _tag: 'Log', log: 'Shimming XMLHttpRequest' })
  })

  test('should defer ResponseStart until response headers are available', () => {
    installSniffer()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr')
    xhr.send()

    expect(withTag(getMessages(), 'ResponseStart')).toHaveLength(0)

    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'data', configurable: true })
    xhr.dispatchEvent(new Event('progress'))

    const starts = withTag(getMessages(), 'ResponseStart')
    expect(starts).toHaveLength(1)
    expect(starts[0]?.url).toBe('https://test.example/xhr')
    expect(starts[0]?.status).toBe(200)
    expect(starts[0]?.statusText).toBe('OK')
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

    const datas = withTag(getMessages(), 'ResponseData')
    expect(datas).toHaveLength(1)
    expect(fromBase64(datas[0]?.data as string)).toBe('final data')
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(1)
  })

  test('should post RequestError on XHR error event', () => {
    installSniffer()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr-err')
    xhr.send()

    xhr.dispatchEvent(new Event('error'))

    const errors = withTag(getMessages(), 'RequestError')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.url).toBe('https://test.example/xhr-err')
    expect(errors[0]?.message).toBe('XMLHttpRequest error')
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
      })
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

    const allData = withTag(getMessages(), 'ResponseData')
    const newData = allData.slice(firstDataCount)
    expect(newData).toHaveLength(1)

    const starts = withTag(getMessages(), 'ResponseStart')
    expect(starts).toHaveLength(2)
    expect(newData[0]?.id).toBe(starts[1]?.id)
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
    const dataBeforeCancel = withTag(getMessages(), 'ResponseData').length
    expect(dataBeforeCancel).toBe(1)

    const starts = withTag(getMessages(), 'ResponseStart')
    const requestId = starts[0]?.id as string

    cancelRequest(requestId)

    enqueueChunk('second')
    await reader.read()
    expect(withTag(getMessages(), 'ResponseData').length).toBe(dataBeforeCancel)

    closeStream()
    await reader.read()
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(0)
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

    const starts = withTag(getMessages(), 'ResponseStart')
    const requestId = starts[0]?.id as string
    const dataBeforeCancel = withTag(getMessages(), 'ResponseData').length

    cancelRequest(requestId)

    Object.defineProperty(xhr, 'responseText', { value: 'first more', configurable: true })
    xhr.dispatchEvent(new Event('progress'))
    expect(withTag(getMessages(), 'ResponseData').length).toBe(dataBeforeCancel)

    xhr.dispatchEvent(new Event('load'))
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(0)
  })

  test('should ignore non-CancelSnifferRequest message events', () => {
    installSniffer()
    // Garbage payloads must not throw / not mutate state.
    window.dispatchEvent(new MessageEvent('message', { data: 'not json' }))
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ _tag: 'Other' }) }))
    window.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify({ _tag: 'CancelSnifferRequest' }) })
    )
    // No assertion needed — the goal is to not throw and not cancel anything.
    expect(getState()?.activeRequests.size).toBe(0)
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

  test('should post PageLoaded with document content on window load event', () => {
    installSniffer()
    window.dispatchEvent(new Event('load'))

    const loaded = withTag(getMessages(), 'PageLoaded')
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.url).toBe(window.location.href)
    expect(typeof loaded[0]?.content).toBe('string')
    expect((loaded[0]?.content as string).length).toBeGreaterThan(0)
  })

  test('should produce a schema-valid PageLoaded message', () => {
    installSniffer()
    window.dispatchEvent(new Event('load'))
    const loaded = withTag(getMessages(), 'PageLoaded')
    validateMessages(loaded)
  })

  test('should not register the load listener twice on double injection', () => {
    installSniffer()
    installSniffer()
    window.dispatchEvent(new Event('load'))

    const loaded = withTag(getMessages(), 'PageLoaded')
    expect(loaded).toHaveLength(1)
  })

  test('should serialize the entire <html>… subtree, including arbitrary body content', () => {
    document.body.innerHTML = '<p id="x">hello &amp; goodbye</p>'
    installSniffer()
    window.dispatchEvent(new Event('load'))

    const loaded = withTag(getMessages(), 'PageLoaded')
    expect(loaded).toHaveLength(1)
    const content = loaded[0]?.content as string
    expect(content).toMatch(/^<html/)
    expect(content).toMatch(/<\/html>$/)
    // `&amp;` survives the HTML-escaped round-trip — `Element.outerHTML`
    // entity-encodes for HTML, no separate unescape pass needed by the host.
    expect(content).toContain('<p id="x">hello &amp; goodbye</p>')
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

    const loaded = withTag(getMessages(), 'PageLoaded')
    const content = loaded[0]?.content as string
    expect(content).toContain('<svg')
    expect(content).toContain('<circle')
    // jsdom's HTML serializer closes `<circle>` per HTML rules — either
    // self-closing or with an explicit `</circle>`; we accept both shapes
    // so a future jsdom upgrade doesn't break the test.
    expect(content).toMatch(/(?:<circle[^>]*\/>|<circle[^>]*><\/circle>)/)
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
    const msgs = getMessages()
    expect(msgs[0]).toEqual({ _tag: '__Ready' })
    expect(getState()?.nativeFetch).toBeDefined()
    expect(getState()?.nativeXHROpen).toBeDefined()
    expect(getState()?.hostMessageHandler).toBeDefined()
  })
})
