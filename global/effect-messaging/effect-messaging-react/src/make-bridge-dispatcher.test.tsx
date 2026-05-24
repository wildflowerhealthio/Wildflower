import { renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test, vi } from 'vite-plus/test'

import { makeBridgeDispatcher } from './make-bridge-dispatcher.tsx'
import { inboundSequenceArb } from './test-utils/test-arbitraries.ts'
import { NavigationBridge, testBridges } from './test-utils/test-bridges.ts'

const silenceReactErrorBoundary = (): (() => void) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (): void => {
    spy.mockRestore()
  }
}

describe('makeBridgeDispatcher — examples', () => {
  test('dispatch with no registered handler resolves without throwing', async () => {
    const { BridgeDispatchRegistryProvider, useMessageSender } = makeBridgeDispatcher(
      'Test',
      testBridges,
      'Host'
    )
    const { result } = renderHook(() => useMessageSender(), {
      wrapper: ({ children }) => (
        <BridgeDispatchRegistryProvider>{children}</BridgeDispatchRegistryProvider>
      ),
    })
    const exit = await Effect.runPromise(
      Effect.exit(result.current({ _tag: 'RouteChanged', pathname: '/x', canGoBack: false }))
    )
    expect(exit._tag).toBe('Success')
  })

  test('undefined handlers in the partial record are skipped', async () => {
    const { BridgeDispatchRegistryProvider, useAsMessageHandlers, useMessageSender } =
      makeBridgeDispatcher('Test', testBridges, 'Host')
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
        useAsMessageHandlers(handlers)
        return useMessageSender()
      },
      {
        wrapper: ({ children }) => (
          <BridgeDispatchRegistryProvider>{children}</BridgeDispatchRegistryProvider>
        ),
      }
    )

    await Effect.runPromise(
      result.current({ _tag: 'RouteChanged', pathname: '/x', canGoBack: false })
    )
    expect(received).toEqual(['/x'])
  })

  test('multi-call: handlers from two separate `useAsMessageHandlers` calls share the same provider without interference', async () => {
    const { BridgeDispatchRegistryProvider, useAsMessageHandlers, useMessageSender } =
      makeBridgeDispatcher('Test', testBridges, 'Host')
    const received: Array<string> = []
    const handlers = {
      RouteChanged: (m: { readonly pathname: string }) =>
        Effect.sync(() => {
          received.push(m.pathname)
        }),
    }

    const { result } = renderHook(
      () => {
        useAsMessageHandlers(handlers)
        // A second registration with no handlers must be a no-op rather than
        // an error — the empty partial record exercises the loop's skip path.
        useAsMessageHandlers({})
        return useMessageSender()
      },
      {
        wrapper: ({ children }) => (
          <BridgeDispatchRegistryProvider>{children}</BridgeDispatchRegistryProvider>
        ),
      }
    )

    await Effect.runPromise(
      result.current({ _tag: 'RouteChanged', pathname: '/multi', canGoBack: false })
    )
    expect(received).toEqual(['/multi'])
  })
})

describe('makeBridgeDispatcher — context errors', () => {
  test('useAsMessageHandlers throws NoContextException outside BridgeDispatchRegistryProvider', () => {
    const { useAsMessageHandlers } = makeBridgeDispatcher('Test', testBridges, 'Host')
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => useAsMessageHandlers({}))).toThrow(NoContextException)
    } finally {
      restore()
    }
  })

  test('useMessageSender throws NoContextException outside BridgeDispatchRegistryProvider', () => {
    const { useMessageSender } = makeBridgeDispatcher('Test', testBridges, 'Host')
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => useMessageSender())).toThrow(NoContextException)
    } finally {
      restore()
    }
  })
})

describe('makeBridgeDispatcher — properties', () => {
  test('fanout exactness: dispatching N messages calls every registered handler exactly once per matching message', async () => {
    await fc.assert(
      fc.asyncProperty(
        inboundSequenceArb,
        fc.integer({ min: 1, max: 4 }),
        async (messages, handlerCount) => {
          const { BridgeDispatchRegistryProvider, useAsMessageHandlers, useMessageSender } =
            makeBridgeDispatcher('Test', testBridges, 'Host')

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
                useAsMessageHandlers(h)
              }
              return useMessageSender()
            },
            {
              wrapper: ({ children }) => (
                <BridgeDispatchRegistryProvider>{children}</BridgeDispatchRegistryProvider>
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
          // Reference the bridge so the static narrowing remains exercised
          // even though the handler shape doesn't depend on it at runtime.
          expect(NavigationBridge.name).toBe('Navigation')
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
          const { BridgeDispatchRegistryProvider, useAsMessageHandlers, useMessageSender } =
            makeBridgeDispatcher('Test', testBridges, 'Host')
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
              useAsMessageHandlers(mounted ? handlers : {})
              return useMessageSender()
            },
            {
              wrapper: ({ children }) => (
                <BridgeDispatchRegistryProvider>{children}</BridgeDispatchRegistryProvider>
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

          // Only the `before` batch reaches the handler; after-unmount drops.
          expect(received).toEqual(beforeMessages.map((m) => m.pathname))
        }
      ),
      { numRuns: 25 }
    )
  })
})
