/**
 * @jest-environment ./browser-sniffer/jest-environment-web.cjs
 */
// oxlint-disable @typescript-eslint/no-unsafe-type-assertion
// oxlint-disable @typescript-eslint/require-array-sort-compare
import { it, fc } from '@fast-check/jest'
import { Schema } from 'effect'

import { AnyMessage } from './messages'

import snifferCode from './sniffer-text'

declare global {
  interface Window {
    ReactNativeWebView: { postMessage: (msg: string) => void }
    nativeFetch?: typeof fetch
    nativeXHROpen?: (...args: unknown[]) => unknown
    nativeXHRSend?: (...args: unknown[]) => unknown
    cancelSnifferRequest?: (id: string) => void
    _snifferPageLoadHandler?: () => void
  }
}

interface Message {
  readonly _tag: string
  readonly [key: string]: unknown
}

const injectSniffer = (): void => {
  // oxlint-disable-next-line no-implied-eval -- Intentional dynamic code injection
  new Function(snifferCode)()
}

const resetShims = (): void => {
  if (window.nativeFetch) {
    window.fetch = window.nativeFetch
  }
  delete window.nativeFetch
  delete window.nativeXHROpen
  delete window.nativeXHRSend
  delete window.cancelSnifferRequest
  if (window._snifferPageLoadHandler) {
    window.removeEventListener('load', window._snifferPageLoadHandler)
    delete window._snifferPageLoadHandler
  }
}

const setupEnv = () => {
  const postMessage = jest.fn()
  window.ReactNativeWebView = { postMessage }
  return () => postMessage.mock.calls.map(([json]: [string]) => JSON.parse(json) as Message)
}

const withTag = (msgs: Message[], tag: string): Message[] => msgs.filter((m) => m._tag === tag)

const decodeAnyMessage = Schema.decodeUnknownSync(AnyMessage)

const validateMessages = (msgs: Message[]): void => {
  for (const msg of msgs) {
    expect(() => decodeAnyMessage(msg)).not.toThrow()
  }
}

const fromBase64 = (b64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))

describe('fetch shim', () => {
  let getMessages: () => Message[]

  beforeEach(() => {
    resetShims()
    getMessages = setupEnv()
  })

  afterEach(resetShims)

  it('should store original fetch as window.nativeFetch', () => {
    // Arrange
    const original = window.fetch

    // Act
    injectSniffer()

    // Assert
    expect(window.nativeFetch).toBe(original)
    expect(window.fetch).not.toBe(original)
  })

  it('should log shim installation', () => {
    // Act
    injectSniffer()

    // Assert
    expect(getMessages()).toContainEqual({ _tag: 'Log', log: 'Shimming fetch' })
  })

  it('should include status and statusText in ResponseStart', async () => {
    // Arrange
    window.fetch = jest
      .fn()
      .mockResolvedValue(new Response('ok', { status: 201, statusText: 'Created' }))
    injectSniffer()

    // Act
    const res = await window.fetch('https://test.example/created')
    await res.text()

    // Assert
    const starts = withTag(getMessages(), 'ResponseStart')
    expect(starts).toHaveLength(1)
    expect(starts[0].status).toBe(201)
    expect(starts[0].statusText).toBe('Created')
  })

  it('should capture response headers in ResponseStart', async () => {
    // Arrange
    window.fetch = jest.fn().mockResolvedValue(
      new Response('ok', {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-custom': 'test-value' },
      })
    )
    injectSniffer()

    // Act
    const res = await window.fetch('https://test.example/headers')
    await res.text()

    // Assert
    const starts = withTag(getMessages(), 'ResponseStart')
    expect(starts).toHaveLength(1)
    expect(starts[0].headers).toBeDefined()
    const headers = starts[0].headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-custom']).toBe('test-value')
    validateMessages(getMessages())
  })

  it('should handle bodyless responses with immediate ResponseFinished', async () => {
    // Arrange
    window.fetch = jest.fn().mockResolvedValue(new Response(null, { status: 204 }))
    injectSniffer()

    // Act
    await window.fetch('https://test.example/empty')

    // Assert
    expect(withTag(getMessages(), 'ResponseData')).toHaveLength(0)
    expect(withTag(getMessages(), 'ResponseStart')).toHaveLength(1)
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(1)
  })

  it('should post RequestError and re-throw on fetch network error', async () => {
    // Arrange
    window.fetch = jest.fn().mockRejectedValue(new Error('network down'))
    injectSniffer()

    // Act & Assert
    await expect(window.fetch('https://test.example/fail')).rejects.toThrow('network down')
    const errors = withTag(getMessages(), 'RequestError')
    expect(errors).toHaveLength(1)
    expect(errors[0].url).toBe('https://test.example/fail')
    expect(errors[0].message).toBe('network down')
    validateMessages(getMessages())
  })

  it('should handle Request object input', async () => {
    // Arrange
    window.fetch = jest.fn().mockResolvedValue(new Response(null))
    injectSniffer()

    // Act
    await window.fetch(new Request('https://test.example/req-obj'))

    // Assert
    const starts = withTag(getMessages(), 'ResponseStart')
    expect(starts[0].url).toBe('https://test.example/req-obj')
  })

  it('should not pass the original Response as init to new Response()', async () => {
    // Arrange
    const expected = '{"resourceType":"Patient","id":"42"}'
    window.fetch = jest.fn().mockResolvedValue(new Response(expected))
    const NativeResponse = globalThis.Response
    const initBodies: unknown[] = []
    globalThis.Response = class extends NativeResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit & { body?: unknown }) {
        super(body, init)
        if (init && 'body' in init) {
          initBodies.push(init.body)
        }
      }
    } as typeof Response
    injectSniffer()

    // Act
    const res = await window.fetch('https://test.example/patient')
    const text = await res.text()
    globalThis.Response = NativeResponse

    // Assert — init should never contain a .body property
    expect(initBodies).toHaveLength(0)
    expect(text).toBe(expected)
  })

  it('should produce messages that validate against AnyMessage schema', async () => {
    // Arrange
    window.fetch = jest.fn().mockResolvedValue(new Response('hello'))
    injectSniffer()

    // Act
    const res = await window.fetch('https://test.example/schema')
    await res.text()

    // Assert
    validateMessages(getMessages())
  })

  it.prop([fc.string({ unit: 'grapheme' })])(
    'should reconstruct original body from base64-encoded ResponseData chunks',
    async (body) => {
      // Arrange
      resetShims()
      const getMs = setupEnv()
      window.fetch = jest.fn().mockResolvedValue(new Response(body))
      injectSniffer()

      // Act
      const res = await window.fetch('https://test.example/data')
      await res.text()

      // Assert
      const datas = withTag(getMs(), 'ResponseData')
      const reconstructed = datas.map((m) => fromBase64(m.data as string)).join('')
      expect(reconstructed).toBe(body)
    }
  )

  it.prop([fc.webUrl()])('should pass through the request URL in ResponseStart', async (url) => {
    // Arrange
    resetShims()
    const getMs = setupEnv()
    window.fetch = jest.fn().mockResolvedValue(new Response(null))
    injectSniffer()

    // Act
    await window.fetch(url)

    // Assert
    const starts = withTag(getMs(), 'ResponseStart')
    expect(starts).toHaveLength(1)
    expect(starts[0].url).toBe(url)
  })

  it.prop([fc.webUrl(), fc.string({ unit: 'grapheme' })])(
    'should post exactly one ResponseStart and one ResponseFinished per request',
    async (url, body) => {
      // Arrange
      resetShims()
      const getMs = setupEnv()
      window.fetch = jest.fn().mockResolvedValue(new Response(body))
      injectSniffer()

      // Act
      const res = await window.fetch(url)
      await res.text()

      // Assert
      const msgs = getMs().filter((m) => m._tag !== 'Log')
      expect(withTag(msgs, 'ResponseStart')).toHaveLength(1)
      expect(withTag(msgs, 'ResponseFinished')).toHaveLength(1)
    }
  )

  it.prop([fc.string({ unit: 'grapheme' })])(
    'should use a consistent ID across all messages for one request',
    async (body) => {
      // Arrange
      resetShims()
      const getMs = setupEnv()
      window.fetch = jest.fn().mockResolvedValue(new Response(body))
      injectSniffer()

      // Act
      const res = await window.fetch('https://test.example')
      await res.text()

      // Assert
      const msgs = getMs().filter((m) => m._tag !== 'Log')
      const ids = new Set(msgs.map((m) => m.id))
      expect(ids.size).toBe(1)
    }
  )

  it.prop([fc.string({ unit: 'grapheme' })])(
    'should produce schema-valid messages for any body',
    async (body) => {
      // Arrange
      resetShims()
      const getMs = setupEnv()
      window.fetch = jest.fn().mockResolvedValue(new Response(body))
      injectSniffer()

      // Act
      const res = await window.fetch('https://test.example/validate')
      await res.text()

      // Assert
      validateMessages(getMs())
    }
  )

  it('should correctly correlate concurrent fetch requests with distinct IDs', async () => {
    // Arrange
    let resolveA!: (v: Response) => void
    let resolveB!: (v: Response) => void
    const promiseA = new Promise<Response>((r) => {
      resolveA = r
    })
    const promiseB = new Promise<Response>((r) => {
      resolveB = r
    })

    let callCount = 0
    window.fetch = jest.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return promiseA
      return promiseB
    })
    injectSniffer()

    // Act — start two concurrent fetches
    const fetchA = window.fetch('https://test.example/a')
    const fetchB = window.fetch('https://test.example/b')

    // Resolve in reverse order
    resolveB(new Response('body-b', { status: 200 }))
    resolveA(new Response('body-a', { status: 200 }))

    const resA = await fetchA
    const resB = await fetchB
    await resA.text()
    await resB.text()

    // Assert — each request should have a distinct ID
    const starts = withTag(getMessages(), 'ResponseStart')
    expect(starts).toHaveLength(2)
    const idA = starts.find((s) => s.url === 'https://test.example/a')!.id as string
    const idB = starts.find((s) => s.url === 'https://test.example/b')!.id as string
    expect(idA).not.toBe(idB)

    // Each Finished message should match its Start ID
    const finishes = withTag(getMessages(), 'ResponseFinished')
    expect(finishes).toHaveLength(2)
    expect(finishes.map((f) => f.id).toSorted()).toEqual([idA, idB].toSorted())

    // Data messages should be tagged to the correct request
    const dataMessages = withTag(getMessages(), 'ResponseData')
    for (const d of dataMessages) {
      expect([idA, idB]).toContain(d.id)
    }
    validateMessages(getMessages())
  })
})

describe('XHR shim', () => {
  let getMessages: () => Message[]

  beforeEach(() => {
    resetShims()
    getMessages = setupEnv()
  })

  afterEach(resetShims)

  it('should store original open/send on window', () => {
    // Act
    injectSniffer()

    // Assert
    expect(window.nativeXHROpen).toBeDefined()
    expect(window.nativeXHRSend).toBeDefined()
  })

  it('should log shim installation', () => {
    // Act
    injectSniffer()

    // Assert
    expect(getMessages()).toContainEqual({
      _tag: 'Log',
      log: 'Shimming XMLHttpRequest',
    })
  })

  it('should defer ResponseStart until response headers are available', () => {
    // Arrange
    injectSniffer()
    window.nativeXHRSend = jest.fn()
    window.nativeXHROpen = jest.fn()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr')
    xhr.send()

    // Assert — no ResponseStart yet (deferred until progress/load)
    expect(withTag(getMessages(), 'ResponseStart')).toHaveLength(0)

    // Act — simulate response arriving
    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'data', configurable: true })
    xhr.dispatchEvent(new Event('progress'))

    // Assert — now ResponseStart should be posted with status/statusText
    const starts = withTag(getMessages(), 'ResponseStart')
    expect(starts).toHaveLength(1)
    expect(starts[0].url).toBe('https://test.example/xhr')
    expect(starts[0].status).toBe(200)
    expect(starts[0].statusText).toBe('OK')
  })

  it('should post ResponseFinished on load with remaining text flushed as base64', () => {
    // Arrange
    injectSniffer()
    window.nativeXHRSend = jest.fn()
    window.nativeXHROpen = jest.fn()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr')
    xhr.send()

    // Act
    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'final data', configurable: true })
    xhr.dispatchEvent(new Event('load'))

    // Assert
    const datas = withTag(getMessages(), 'ResponseData')
    expect(datas).toHaveLength(1)
    expect(fromBase64(datas[0].data as string)).toBe('final data')
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(1)
  })

  it('should post RequestError on XHR error event', () => {
    // Arrange
    injectSniffer()
    window.nativeXHRSend = jest.fn()
    window.nativeXHROpen = jest.fn()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr-err')
    xhr.send()

    // Act
    xhr.dispatchEvent(new Event('error'))

    // Assert
    const errors = withTag(getMessages(), 'RequestError')
    expect(errors).toHaveLength(1)
    expect(errors[0].url).toBe('https://test.example/xhr-err')
    expect(errors[0].message).toBe('XMLHttpRequest error')
    validateMessages(getMessages())
  })

  it('should post ResponseFinished on abort', () => {
    // Arrange
    injectSniffer()
    window.nativeXHRSend = jest.fn()
    window.nativeXHROpen = jest.fn()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr')
    xhr.send()

    // Act
    xhr.dispatchEvent(new Event('abort'))

    // Assert
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(1)
  })

  it('should produce schema-valid messages for XHR lifecycle', () => {
    // Arrange
    injectSniffer()
    window.nativeXHRSend = jest.fn()
    window.nativeXHROpen = jest.fn()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/xhr')
    xhr.send()

    // Act
    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'hello', configurable: true })
    xhr.dispatchEvent(new Event('load'))

    // Assert
    validateMessages(getMessages())
  })

  it.prop([fc.array(fc.string({ minLength: 1 }), { minLength: 1 })])(
    'should capture incremental responseText slices as base64-encoded ResponseData',
    (parts) => {
      // Arrange
      resetShims()
      const getMs = setupEnv()
      injectSniffer()
      window.nativeXHRSend = jest.fn()
      window.nativeXHROpen = jest.fn()
      const xhr = new XMLHttpRequest()
      xhr.open('GET', 'https://test.example/xhr')
      xhr.send()

      // Act — simulate progressive response text
      let accumulated = ''
      Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
      Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
      for (const part of parts) {
        accumulated += part
        Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
        Object.defineProperty(xhr, 'responseText', { value: accumulated, configurable: true })
        xhr.dispatchEvent(new Event('progress'))
      }

      // Assert — decoded chunks should exactly match the individual parts
      const datas = withTag(getMs(), 'ResponseData')
      expect(datas.map((m) => fromBase64(m.data as string))).toEqual(parts)
      expect(datas.map((m) => fromBase64(m.data as string)).join('')).toBe(accumulated)
    }
  )

  it('should guard against stale listeners when XHR is reused', () => {
    // Arrange
    injectSniffer()
    window.nativeXHRSend = jest.fn()
    window.nativeXHROpen = jest.fn()
    const xhr = new XMLHttpRequest()

    // First request — full lifecycle
    xhr.open('GET', 'https://test.example/first')
    xhr.send()
    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'first', configurable: true })
    xhr.dispatchEvent(new Event('progress'))

    const firstDataCount = withTag(getMessages(), 'ResponseData').length

    // Reuse for second request
    xhr.open('GET', 'https://test.example/second')
    xhr.send()

    // Act — simulate progress on the reused XHR
    Object.defineProperty(xhr, 'responseText', { value: 'second', configurable: true })
    xhr.dispatchEvent(new Event('progress'))

    // Assert — the second request should have produced exactly one new ResponseData
    const allData = withTag(getMessages(), 'ResponseData')
    const newData = allData.slice(firstDataCount)
    expect(newData).toHaveLength(1)

    // And its ID should match the second ResponseStart, not the first
    const starts = withTag(getMessages(), 'ResponseStart')
    expect(starts).toHaveLength(2)
    expect(newData[0].id).toBe(starts[1].id)
  })
})

describe('cancelSnifferRequest', () => {
  let getMessages: () => Message[]

  beforeEach(() => {
    resetShims()
    getMessages = setupEnv()
  })

  afterEach(resetShims)

  it('should expose window.cancelSnifferRequest after injection', () => {
    // Act
    injectSniffer()

    // Assert
    expect(typeof window.cancelSnifferRequest).toBe('function')
  })

  it('should stop posting ResponseData and ResponseFinished after cancellation (fetch)', async () => {
    // Arrange — use a multi-chunk response to cancel mid-stream
    let enqueueChunk: (chunk: string) => void
    let closeStream: () => void
    const stream = new ReadableStream({
      start(controller) {
        enqueueChunk = (chunk: string) => controller.enqueue(new TextEncoder().encode(chunk))
        closeStream = () => controller.close()
      },
    })
    window.fetch = jest.fn().mockResolvedValue(new Response(stream))
    injectSniffer()

    // Act — start consuming
    const res = await window.fetch('https://test.example/cancel')
    const reader = res.body!.getReader()

    // First chunk should produce ResponseData
    enqueueChunk!('first')
    await reader.read()
    const dataBeforeCancel = withTag(getMessages(), 'ResponseData').length
    expect(dataBeforeCancel).toBe(1)

    // Get the request ID from ResponseStart
    const starts = withTag(getMessages(), 'ResponseStart')
    const requestId = starts[0].id as string

    // Cancel the request
    window.cancelSnifferRequest!(requestId)

    // Second chunk should NOT produce ResponseData
    enqueueChunk!('second')
    await reader.read()
    expect(withTag(getMessages(), 'ResponseData').length).toBe(dataBeforeCancel)

    // Close stream — should NOT produce ResponseFinished
    closeStream!()
    await reader.read()
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(0)
  })

  it('should stop posting data after cancellation (XHR)', () => {
    // Arrange
    injectSniffer()
    window.nativeXHRSend = jest.fn()
    window.nativeXHROpen = jest.fn()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'https://test.example/cancel-xhr')
    xhr.send()

    // Trigger first progress to get ResponseStart
    Object.defineProperty(xhr, 'status', { value: 200, configurable: true })
    Object.defineProperty(xhr, 'statusText', { value: 'OK', configurable: true })
    Object.defineProperty(xhr, 'responseType', { value: '', configurable: true })
    Object.defineProperty(xhr, 'responseText', { value: 'first', configurable: true })
    xhr.dispatchEvent(new Event('progress'))

    const starts = withTag(getMessages(), 'ResponseStart')
    const requestId = starts[0].id as string
    const dataBeforeCancel = withTag(getMessages(), 'ResponseData').length

    // Act — cancel
    window.cancelSnifferRequest!(requestId)

    // More data arrives — should be ignored
    Object.defineProperty(xhr, 'responseText', { value: 'first more', configurable: true })
    xhr.dispatchEvent(new Event('progress'))
    expect(withTag(getMessages(), 'ResponseData').length).toBe(dataBeforeCancel)

    // Load fires — no ResponseFinished
    xhr.dispatchEvent(new Event('load'))
    expect(withTag(getMessages(), 'ResponseFinished')).toHaveLength(0)
  })
})

describe('PageLoaded', () => {
  let getMessages: () => Message[]

  beforeEach(() => {
    resetShims()
    getMessages = setupEnv()
  })

  afterEach(resetShims)

  it('should post PageLoaded with document content on window load event', () => {
    // Arrange
    injectSniffer()

    // Act
    window.dispatchEvent(new Event('load'))

    // Assert
    const loaded = withTag(getMessages(), 'PageLoaded')
    expect(loaded).toHaveLength(1)
    expect(loaded[0].url).toBe(window.location.href)
    expect(typeof loaded[0].content).toBe('string')
    expect((loaded[0].content as string).length).toBeGreaterThan(0)
  })

  it('should produce a schema-valid PageLoaded message', () => {
    // Arrange
    injectSniffer()

    // Act
    window.dispatchEvent(new Event('load'))

    // Assert
    const loaded = withTag(getMessages(), 'PageLoaded')
    validateMessages(loaded)
  })

  it('should not register the load listener twice on double injection', () => {
    // Arrange
    injectSniffer()
    injectSniffer()

    // Act
    window.dispatchEvent(new Event('load'))

    // Assert
    const loaded = withTag(getMessages(), 'PageLoaded')
    expect(loaded).toHaveLength(1)
  })
})

describe('injection', () => {
  beforeEach(() => {
    resetShims()
    setupEnv()
  })

  afterEach(resetShims)

  it('should not double-shim when injected multiple times', () => {
    // Arrange
    injectSniffer()
    const firstShimmedFetch = window.fetch
    const firstNativeFetch = window.nativeFetch

    // Act
    injectSniffer()

    // Assert — same shim, same native reference
    expect(window.fetch).toBe(firstShimmedFetch)
    expect(window.nativeFetch).toBe(firstNativeFetch)
  })
})
