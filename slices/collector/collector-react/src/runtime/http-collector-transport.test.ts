import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  eventsUrlFor,
  httpRequestForMessage,
  makeHttpCollectorTransport,
  type CollectorHandlers,
  type EventSocket,
} from './http-collector-transport.ts'

describe('httpRequestForMessage', () => {
  it('should map every outbound tag onto its /sniffer endpoint', () => {
    // Arrange — one message per web→host tag, realistic payloads.
    const source = { _tag: 'Uri', uri: 'https://emr.example.test/portal' } as const

    // Act / Assert — the whole control-plane mapping in one table.
    expect(httpRequestForMessage({ _tag: 'RequestSniffableWebView', source })).toEqual({
      method: 'POST',
      path: '/sniffer/webview',
      body: { source },
    })
    expect(httpRequestForMessage({ _tag: 'Open', source })).toEqual({
      method: 'POST',
      path: '/sniffer/webview',
      body: { source },
    })
    expect(httpRequestForMessage({ _tag: 'SniffingComplete' })).toEqual({
      method: 'DELETE',
      path: '/sniffer/webview',
    })
    expect(httpRequestForMessage({ _tag: 'SetSnifferStatus', name: 'Entering email' })).toEqual({
      method: 'PUT',
      path: '/sniffer/status',
      body: { name: 'Entering email' },
    })
    expect(httpRequestForMessage({ _tag: 'EnsureSnifferVisible' })).toEqual({
      method: 'POST',
      path: '/sniffer/visibility',
    })
    expect(
      httpRequestForMessage({
        _tag: 'PageAction',
        action: { kind: 'Click', querySelector: '#go' },
      })
    ).toEqual({
      method: 'POST',
      path: '/sniffer/page-actions',
      body: { action: { kind: 'Click', querySelector: '#go' } },
    })
    expect(httpRequestForMessage({ _tag: 'CancelSnifferRequest', id: 'req-1' })).toEqual({
      method: 'POST',
      path: '/sniffer/cancellations',
      body: { id: 'req-1' },
    })
  })

  it('should carry linkedSpan on the open body only when present', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (traceId, spanId) => {
        // Arrange
        const source = { _tag: 'Uri', uri: 'https://emr.example.test/' } as const

        // Act
        const withSpan = httpRequestForMessage({
          _tag: 'RequestSniffableWebView',
          source,
          linkedSpan: { traceId, spanId },
        })
        const withoutSpan = httpRequestForMessage({ _tag: 'RequestSniffableWebView', source })

        // Assert
        expect(withSpan.body).toEqual({ source, linkedSpan: { traceId, spanId } })
        expect(withoutSpan.body).toEqual({ source })
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('eventsUrlFor', () => {
  it('should derive a ws:// URL from an http:// API base', () => {
    expect(eventsUrlFor('http://127.0.0.1:8080', 'http://unused.test')).toBe(
      'ws://127.0.0.1:8080/sniffer/events'
    )
  })

  it('should derive a wss:// URL from an https:// page origin when no base is set', () => {
    expect(eventsUrlFor(undefined, 'https://phone.tunnel.example')).toBe(
      'wss://phone.tunnel.example/sniffer/events'
    )
  })
})

describe('makeHttpCollectorTransport', () => {
  describe('sender', () => {
    it('should POST the open request with credentials and a JSON body', async () => {
      // Arrange
      const { fetchFn, calls } = fakeFetch(204)
      const { sender } = makeHttpCollectorTransport({
        apiBaseUrl: 'http://127.0.0.1:8080',
        fetchFn,
        createSocket: () => fakeSocket().socket,
        pageOrigin: 'http://page.test',
      })

      // Act
      await Effect.runPromise(
        sender({
          _tag: 'RequestSniffableWebView',
          source: { _tag: 'Uri', uri: 'https://emr.example.test/portal' },
        })
      )

      // Assert
      expect(calls).toHaveLength(1)
      const [url, init] = calls[0] ?? []
      expect(url).toBe('http://127.0.0.1:8080/sniffer/webview')
      expect(init?.method).toBe('POST')
      expect(init?.credentials).toBe('include')
      expect(jsonBodyOf(init)).toEqual({
        source: { _tag: 'Uri', uri: 'https://emr.example.test/portal' },
      })
    })

    it('should never fail the caller, even when the host answers non-2xx or fetch rejects', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.integer({ min: 400, max: 599 }).map((status) => fakeFetch(status).fetchFn),
            fc.constant<typeof fetch>(() => Promise.reject(new Error('network down')))
          ),
          async (fetchFn) => {
            // Arrange
            const { sender } = makeHttpCollectorTransport({
              fetchFn,
              createSocket: () => fakeSocket().socket,
              pageOrigin: 'http://page.test',
            })

            // Act — the fire-and-forget contract: this must resolve.
            const result = await Effect.runPromise(sender({ _tag: 'SniffingComplete' }))

            // Assert
            expect(result).toBeUndefined()
          }
        ),
        { numRuns: numRunsFor({ base: 25 }) }
      )
    })
  })

  describe('register', () => {
    it('should resolve register only once the socket is open', async () => {
      // Arrange
      const { socket, open } = fakeSocket()
      const { register } = makeHttpCollectorTransport({
        fetchFn: fakeFetch(204).fetchFn,
        createSocket: () => socket,
        pageOrigin: 'http://page.test',
      }).register

      // Act
      let registered = false
      const pending = Effect.runPromise(register(dropAllHandlers())).then(() => {
        registered = true
      })
      await Promise.resolve()
      expect(registered).toBe(false)
      open()
      await pending

      // Assert
      expect(registered).toBe(true)
    })

    it('should dispatch decoded events to their tag handlers in arrival order', async () => {
      // Arrange
      const { socket, open, emit } = fakeSocket()
      const transport = makeHttpCollectorTransport({
        fetchFn: fakeFetch(204).fetchFn,
        createSocket: () => socket,
        pageOrigin: 'http://page.test',
      })
      const seen: string[] = []
      const handlers: CollectorHandlers = {
        ...dropAllHandlers(),
        ResponseStart: (message) =>
          Effect.sync(() => {
            seen.push(`start:${message.id}`)
          }),
        ResponseData: (message) =>
          Effect.sync(() => {
            seen.push(`data:${message.id}:${message.data}`)
          }),
        ResponseFinished: (message) =>
          Effect.sync(() => {
            seen.push(`finished:${message.id}`)
          }),
      }
      const registration = Effect.runPromise(transport.register.register(handlers))
      open()
      await registration

      // Act — a chunked response stream interleaved exactly as the wire sends it.
      emit(
        '{"_tag":"ResponseStart","id":"r1","url":"https://emr.example.test/fhir/Patient","status":200,"statusText":"OK","headers":[]}'
      )
      emit('{"_tag":"ResponseData","id":"r1","data":"AA=="}')
      emit('{"_tag":"ResponseData","id":"r1","data":"BB=="}')
      emit('{"_tag":"ResponseFinished","id":"r1"}')
      await flushDispatch()

      // Assert — cross-tag FIFO preserved.
      expect(seen).toEqual(['start:r1', 'data:r1:AA==', 'data:r1:BB==', 'finished:r1'])
    })

    it('should drop unknown tags and undecodable frames without disturbing later events', async () => {
      // Arrange
      const { socket, open, emit } = fakeSocket()
      const transport = makeHttpCollectorTransport({
        fetchFn: fakeFetch(204).fetchFn,
        createSocket: () => socket,
        pageOrigin: 'http://page.test',
      })
      const seen: string[] = []
      const handlers: CollectorHandlers = {
        ...dropAllHandlers(),
        UserDismissed: () =>
          Effect.sync(() => {
            seen.push('dismissed')
          }),
      }
      const registration = Effect.runPromise(transport.register.register(handlers))
      open()
      await registration

      // Act
      emit('{"_tag":"Log","level":"warn","payload":["noise"]}')
      emit('not json at all')
      emit('{"_tag":"ResponseFinished"}') // undecodable: missing id
      emit('{"_tag":"UserDismissed"}')
      await flushDispatch()

      // Assert
      expect(seen).toEqual(['dismissed'])
    })

    it('should keep dispatching later events after a handler dies mid-stream', async () => {
      // Arrange — a defect (not a typed failure) must not strand the frames
      // queued behind it: `Effect.runPromise` would reject and abort the pass.
      const { socket, open, emit } = fakeSocket()
      const transport = makeHttpCollectorTransport({
        fetchFn: fakeFetch(204).fetchFn,
        createSocket: () => socket,
        pageOrigin: 'http://page.test',
      })
      const seen: string[] = []
      const handlers: CollectorHandlers = {
        ...dropAllHandlers(),
        ResponseStart: () =>
          Effect.sync(() => {
            throw new Error('tracker blew up')
          }),
        ResponseFinished: (message) =>
          Effect.sync(() => {
            seen.push(`finished:${message.id}`)
          }),
      }
      const registration = Effect.runPromise(transport.register.register(handlers))
      open()
      await registration

      // Act — the dying frame is followed by a good one in the same batch.
      emit(
        '{"_tag":"ResponseStart","id":"r1","url":"https://emr.example.test/x","status":200,"statusText":"OK","headers":[]}'
      )
      emit('{"_tag":"ResponseFinished","id":"r1"}')
      await flushDispatch()

      // Assert — the tail of the stream still arrived.
      expect(seen).toEqual(['finished:r1'])
    })

    it('should warn but not throw when the host closes the stream abnormally', async () => {
      // Arrange — the server closes with `close_code::ERROR` when its event
      // broadcast lags; that must not be indistinguishable from teardown.
      const { socket, open, close } = fakeSocket()
      const transport = makeHttpCollectorTransport({
        fetchFn: fakeFetch(204).fetchFn,
        createSocket: () => socket,
        pageOrigin: 'http://page.test',
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const registration = Effect.runPromise(transport.register.register(dropAllHandlers()))
      open()
      await registration

      // Act
      close({ code: 1011, reason: 'event stream lagged; reconnect and restart the run' })

      // Assert
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('1011')
      expect(String(warn.mock.calls[0]?.[0])).toContain('event stream lagged')
      warn.mockRestore()
    })

    it('should stay silent when the stream closes normally', async () => {
      // Arrange
      const { socket, open, close } = fakeSocket()
      const transport = makeHttpCollectorTransport({
        fetchFn: fakeFetch(204).fetchFn,
        createSocket: () => socket,
        pageOrigin: 'http://page.test',
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const registration = Effect.runPromise(transport.register.register(dropAllHandlers()))
      open()
      await registration

      // Act
      close({ code: 1000, reason: '' })

      // Assert
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })

    it('should not close a newer run’s socket when an older run releases late', async () => {
      // Arrange — run A registers, run B replaces it, then A's release lands.
      const first = fakeSocket()
      const second = fakeSocket()
      const sockets = [first, second]
      let handedOut = 0
      const transport = makeHttpCollectorTransport({
        fetchFn: fakeFetch(204).fetchFn,
        createSocket: () => {
          const next = sockets[handedOut]
          handedOut += 1
          if (next === undefined) throw new Error('unexpected extra socket')
          return next.socket
        },
        pageOrigin: 'http://page.test',
      })
      const handlersA = dropAllHandlers()
      const handlersB = dropAllHandlers()

      const registrationA = Effect.runPromise(transport.register.register(handlersA))
      first.open()
      await registrationA
      const registrationB = Effect.runPromise(transport.register.register(handlersB))
      second.open()
      await registrationB
      const closesAfterReplacement = second.closeCalls()

      // Act — run A's release arrives after run B took over.
      await Effect.runPromise(transport.register.unregister(handlersA))

      // Assert — B's stream is untouched; only B's own release closes it.
      expect(second.closeCalls()).toBe(closesAfterReplacement)
      await Effect.runPromise(transport.register.unregister(handlersB))
      expect(second.closeCalls()).toBeGreaterThan(closesAfterReplacement)
    })

    it('should stop dispatching after unregister closes the socket', async () => {
      // Arrange
      const { socket, open, emit, closeCalls } = fakeSocket()
      const transport = makeHttpCollectorTransport({
        fetchFn: fakeFetch(204).fetchFn,
        createSocket: () => socket,
        pageOrigin: 'http://page.test',
      })
      const seen: string[] = []
      const handlers: CollectorHandlers = {
        ...dropAllHandlers(),
        UserDismissed: () =>
          Effect.sync(() => {
            seen.push('dismissed')
          }),
      }
      const registration = Effect.runPromise(transport.register.register(handlers))
      open()
      await registration

      // Act
      await Effect.runPromise(transport.register.unregister(handlers))
      emit('{"_tag":"UserDismissed"}')
      await flushDispatch()

      // Assert
      expect(closeCalls()).toBeGreaterThan(0)
      expect(seen).toEqual([])
    })
  })
})

// Helpers

/** A recording fetch stub answering every request with `status`. */
const fakeFetch = (
  status: number
): {
  readonly fetchFn: typeof fetch
  readonly calls: ReadonlyArray<readonly [string, RequestInit | undefined]>
} => {
  const calls: Array<readonly [string, RequestInit | undefined]> = []
  const fetchFn: typeof fetch = (input, init) => {
    calls.push([urlOf(input), init])
    return Promise.resolve(new Response(null, { status }))
  }
  return { fetchFn, calls }
}

/** The request URL of a `fetch` first argument, without a base-to-string coercion. */
const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** The string body of a `RequestInit`, or `''` when absent/non-string. */
const jsonBodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined

/**
 * A hand-driven `EventSocket` fake: `open()` fires onopen, `emit(raw)` a
 * frame, `close({code, reason})` a host-initiated close.
 */
const fakeSocket = (): {
  readonly socket: EventSocket
  readonly open: () => void
  readonly emit: (raw: string) => void
  readonly close: (init: { readonly code: number; readonly reason: string }) => void
  readonly closeCalls: () => number
} => {
  let closes = 0
  const socket: EventSocket = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    close: () => {
      closes += 1
    },
  }
  return {
    socket,
    open: () => {
      socket.onopen?.(new Event('open'))
    },
    emit: (raw) => {
      socket.onmessage?.(new MessageEvent('message', { data: raw }))
    },
    close: ({ code, reason }) => {
      socket.onclose?.(new CloseEvent('close', { code, reason }))
    },
    closeCalls: () => closes,
  }
}

/** A full handler record whose members all acknowledge-and-drop. */
const dropAllHandlers = (): CollectorHandlers => ({
  ResponseStart: () => Effect.void,
  ResponseData: () => Effect.void,
  ResponseFinished: () => Effect.void,
  RequestError: () => Effect.void,
  Cancelled: () => Effect.void,
  PageLoaded: () => Effect.void,
  UserDismissed: () => Effect.void,
  SnifferDisposed: () => Effect.void,
})

/** Let the sequential dispatch pump drain its queued microtasks. */
const flushDispatch = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- draining the pump tick by tick
    await Promise.resolve()
  }
}
