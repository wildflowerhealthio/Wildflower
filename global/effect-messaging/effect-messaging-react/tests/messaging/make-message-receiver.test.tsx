import { renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test } from 'vite-plus/test'

import { makeMessageReceiver } from '../../src/messaging/make-message-receiver.tsx'
import {
  GatekeeperBridge,
  NavigationBridge,
  silenceReactErrorBoundary,
  testBridges,
} from '../fixtures/index.ts'

describe('makeMessageReceiver — dispatch fanout', () => {
  test('dispatch fans out to every registered handler for a tag', async () => {
    const { MessageReceiverProvider, useMessageReceiver, useMessageDispatcher } =
      makeMessageReceiver(testBridges, 'Host')
    const received1: Array<string> = []
    const received2: Array<string> = []
    const handlers1 = {
      RouteChanged: (m: { readonly pathname: string }) =>
        Effect.sync(() => {
          received1.push(m.pathname)
        }),
    }
    const handlers2 = {
      RouteChanged: (m: { readonly pathname: string }) =>
        Effect.sync(() => {
          received2.push(m.pathname)
        }),
    }

    const { result } = renderHook(
      () => {
        useMessageReceiver(NavigationBridge, handlers1)
        useMessageReceiver(NavigationBridge, handlers2)
        return useMessageDispatcher()
      },
      {
        wrapper: ({ children }) => <MessageReceiverProvider>{children}</MessageReceiverProvider>,
      }
    )

    await Effect.runPromise(
      result.current({ _tag: 'RouteChanged', pathname: '/apps', canGoBack: true })
    )
    expect(received1).toEqual(['/apps'])
    expect(received2).toEqual(['/apps'])
  })

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
})

describe('makeMessageReceiver — lifecycle', () => {
  test('handler is deregistered on unmount', async () => {
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
        if (mounted) useMessageReceiver(NavigationBridge, handlers)
        return useMessageDispatcher()
      },
      {
        wrapper: ({ children }) => <MessageReceiverProvider>{children}</MessageReceiverProvider>,
        initialProps: { mounted: true },
      }
    )

    await Effect.runPromise(
      result.current({ _tag: 'RouteChanged', pathname: '/before', canGoBack: false })
    )
    rerender({ mounted: false })
    await Effect.runPromise(
      result.current({ _tag: 'RouteChanged', pathname: '/after', canGoBack: false })
    )
    expect(received).toEqual(['/before'])
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
      // A tag that doesn't exist on the bridge is impossible at the type
      // level; this asserts the loop's `handler === undefined` skip path
      // by passing an explicit undefined under a real tag.
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

describe('makeMessageReceiver — multi-bridge registry sharing', () => {
  test('two different bridges register handlers in the same registry without interfering', async () => {
    const { MessageReceiverProvider, useMessageReceiver, useMessageDispatcher } =
      makeMessageReceiver(testBridges, 'Host')
    // NavigationBridge has webToHost: RouteChanged. GatekeeperBridge has
    // webToHost: [] — no inbound tags. So we can only register navigation
    // handlers, but the dispatcher must serve nav messages regardless of
    // gatekeeper's empty inbound surface.
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
        // Calling useMessageReceiver with an empty handlers object for the
        // gatekeeper bridge proves the empty path is harmless.
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
