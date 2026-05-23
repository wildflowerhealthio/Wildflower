import { renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test, vi } from 'vite-plus/test'

import { makeMessageReceiver } from './make-message-receiver.tsx'
import { inboundSequenceArb } from './test-arbitraries.ts'
import { GatekeeperBridge, NavigationBridge, testBridges } from './test-bridges.ts'

const silenceReactErrorBoundary = (): (() => void) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (): void => {
    spy.mockRestore()
  }
}

describe('makeMessageReceiver — examples', () => {
  test('dispatch with no registered handler resolves without throwing', async () => {
    const { MessageReceiverProvider, useMessageDispatcher } = makeMessageReceiver(
      testBridges,
      'Host'
    )
    const { result } = renderHook(() => useMessageDispatcher(), {
      wrapper: ({ children }) => <MessageReceiverProvider>{children}</MessageReceiverProvider>,
    })
    const exit = await Effect.runPromise(
      Effect.exit(result.current({ _tag: 'RouteChanged', pathname: '/x', canGoBack: false }))
    )
    expect(exit._tag).toBe('Success')
  })

  test('undefined handlers in the partial record are skipped', async () => {
    const { MessageReceiverProvider, useMessageReceiver, useMessageDispatcher } =
      makeMessageReceiver(testBridges, 'Host')
    const received: Array<string> = []
    const handlers = {
      RouteChanged: (m: { readonly pathname: string }) =>
        Effect.sync(() => {
          received.push(m.pathname)
        }),
      ...({ HostBackRequested: undefined } as Record<string, undefined>),
    }

    const { result } = renderHook(
      () => {
        useMessageReceiver(NavigationBridge, handlers)
        return useMessageDispatcher()
      },
      {
        wrapper: ({ children }) => <MessageReceiverProvider>{children}</MessageReceiverProvider>,
      }
    )

    await Effect.runPromise(
      result.current({ _tag: 'RouteChanged', pathname: '/x', canGoBack: false })
    )
    expect(received).toEqual(['/x'])
  })

  test('multi-bridge registry: handlers for different bridges share the same provider without interference', async () => {
    const { MessageReceiverProvider, useMessageReceiver, useMessageDispatcher } =
      makeMessageReceiver(testBridges, 'Host')
    const received: Array<string> = []
    const handlers = {
      RouteChanged: (m: { readonly pathname: string }) =>
        Effect.sync(() => {
          received.push(m.pathname)
        }),
    }

    const { result } = renderHook(
      () => {
        useMessageReceiver(NavigationBridge, handlers)
        // Gatekeeper has no webToHost messages, so the partial record is
        // necessarily empty. The hook must be a no-op rather than an error.
        useMessageReceiver(GatekeeperBridge, {})
        return useMessageDispatcher()
      },
      {
        wrapper: ({ children }) => <MessageReceiverProvider>{children}</MessageReceiverProvider>,
      }
    )

    await Effect.runPromise(
      result.current({ _tag: 'RouteChanged', pathname: '/multi', canGoBack: false })
    )
    expect(received).toEqual(['/multi'])
  })
})

describe('makeMessageReceiver — context errors', () => {
  test('useMessageReceiver throws NoContextException outside MessageReceiverProvider', () => {
    const { useMessageReceiver } = makeMessageReceiver(testBridges, 'Host')
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => useMessageReceiver(NavigationBridge, {}))).toThrow(
        NoContextException
      )
    } finally {
      restore()
    }
  })

  test('useMessageDispatcher throws NoContextException outside MessageReceiverProvider', () => {
    const { useMessageDispatcher } = makeMessageReceiver(testBridges, 'Host')
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => useMessageDispatcher())).toThrow(NoContextException)
    } finally {
      restore()
    }
  })
})

describe('makeMessageReceiver — properties', () => {
  test('fanout exactness: dispatching N messages calls every registered handler exactly once per matching message', async () => {
    await fc.assert(
      fc.asyncProperty(
        inboundSequenceArb,
        fc.integer({ min: 1, max: 4 }),
        async (messages, handlerCount) => {
          const { MessageReceiverProvider, useMessageReceiver, useMessageDispatcher } =
            makeMessageReceiver(testBridges, 'Host')

          const sinks: Array<Array<string>> = Array.from({ length: handlerCount }, () => [])
          const handlers = sinks.map((sink) => ({
            RouteChanged: (m: { readonly pathname: string }) =>
              Effect.sync(() => {
                sink.push(m.pathname)
              }),
          }))

          const { result } = renderHook(
            () => {
              for (const h of handlers) {
                useMessageReceiver(NavigationBridge, h)
              }
              return useMessageDispatcher()
            },
            {
              wrapper: ({ children }) => (
                <MessageReceiverProvider>{children}</MessageReceiverProvider>
              ),
            }
          )

          await Effect.runPromise(
            Effect.forEach(messages, (m) => result.current(m), { discard: true })
          )
          const expected = messages.map((m) => m.pathname)
          for (const sink of sinks) {
            expect(sink).toEqual(expected)
          }
        }
      ),
      { numRuns: 50 }
    )
  })

  test('handler is deregistered on unmount under any mount sequence', async () => {
    await fc.assert(
      fc.asyncProperty(
        inboundSequenceArb,
        inboundSequenceArb,
        async (beforeMessages, afterMessages) => {
          const { MessageReceiverProvider, useMessageReceiver, useMessageDispatcher } =
            makeMessageReceiver(testBridges, 'Host')
          const received: Array<string> = []
          const handlers = {
            RouteChanged: (m: { readonly pathname: string }) =>
              Effect.sync(() => {
                received.push(m.pathname)
              }),
          }

          const { result, rerender } = renderHook(
            ({ mounted }: { mounted: boolean }) => {
              // Toggle by passing an empty handlers record when unmounted —
              // keeps the hook order stable; the empty record triggers
              // useEffect's cleanup to deregister all previous handlers.
              useMessageReceiver(NavigationBridge, mounted ? handlers : {})
              return useMessageDispatcher()
            },
            {
              wrapper: ({ children }) => (
                <MessageReceiverProvider>{children}</MessageReceiverProvider>
              ),
              initialProps: { mounted: true },
            }
          )

          await Effect.runPromise(
            Effect.forEach(beforeMessages, (m) => result.current(m), { discard: true })
          )
          rerender({ mounted: false })
          await Effect.runPromise(
            Effect.forEach(afterMessages, (m) => result.current(m), { discard: true })
          )

          // Only the `before` batch reaches the handler; after-unmount messages drop.
          expect(received).toEqual(beforeMessages.map((m) => m.pathname))
        }
      ),
      { numRuns: 25 }
    )
  })
})
