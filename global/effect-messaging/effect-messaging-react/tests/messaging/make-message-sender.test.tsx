import { renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test } from 'vite-plus/test'

import { makeMessageSender } from '../../src/messaging/make-message-sender.tsx'
import {
  GatekeeperBridge,
  NavigationBridge,
  makeRecordingSender,
  silenceReactErrorBoundary,
  testBridges,
  type TestBridges,
} from '../fixtures/index.ts'

describe('makeMessageSender — Host side', () => {
  test('useMessageSender forwards a typed message to the underlying sendMessage', async () => {
    const { MessageSenderProvider, useMessageSender } = makeMessageSender(testBridges, 'Host')
    const { sender, received } = makeRecordingSender<TestBridges, 'Host'>()

    const { result } = renderHook(() => useMessageSender(NavigationBridge), {
      wrapper: ({ children }) => (
        <MessageSenderProvider sendMessage={sender}>{children}</MessageSenderProvider>
      ),
    })

    await Effect.runPromise(
      result.current.sendEffect({ _tag: 'HostRequestedWebNavigation', path: '/apps' })
    )
    expect(received).toEqual([{ _tag: 'HostRequestedWebNavigation', path: '/apps' }])
  })

  test('useMessageSender returns a stable object across re-renders', () => {
    const { MessageSenderProvider, useMessageSender } = makeMessageSender(testBridges, 'Host')
    const { sender } = makeRecordingSender<TestBridges, 'Host'>()

    const { result, rerender } = renderHook(() => useMessageSender(NavigationBridge), {
      wrapper: ({ children }) => (
        <MessageSenderProvider sendMessage={sender}>{children}</MessageSenderProvider>
      ),
    })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  test('useMessageSender throws NoContextException outside a provider', () => {
    const { useMessageSender } = makeMessageSender(testBridges, 'Host')
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => useMessageSender(NavigationBridge))).toThrow(NoContextException)
    } finally {
      restore()
    }
  })

  test('send is fire-and-forget — same Effect as sendEffect', async () => {
    const { MessageSenderProvider, useMessageSender } = makeMessageSender(testBridges, 'Host')
    const { sender, received } = makeRecordingSender<TestBridges, 'Host'>()

    const { result } = renderHook(() => useMessageSender(GatekeeperBridge), {
      wrapper: ({ children }) => (
        <MessageSenderProvider sendMessage={sender}>{children}</MessageSenderProvider>
      ),
    })
    const ret = result.current.send({ _tag: 'AuthTokenIssued', token: 'tk' })
    await Promise.resolve()
    expect(ret).toBeUndefined()
    expect(received).toEqual([{ _tag: 'AuthTokenIssued', token: 'tk' }])
  })
})

describe('makeMessageSender — Web side (proves Side parameterization)', () => {
  test('useMessageSender on the Web side forwards a webToHost message', async () => {
    const { MessageSenderProvider, useMessageSender } = makeMessageSender(testBridges, 'Web')
    const { sender, received } = makeRecordingSender<TestBridges, 'Web'>()

    const { result } = renderHook(() => useMessageSender(NavigationBridge), {
      wrapper: ({ children }) => (
        <MessageSenderProvider sendMessage={sender}>{children}</MessageSenderProvider>
      ),
    })

    await Effect.runPromise(
      result.current.sendEffect({ _tag: 'RouteChanged', pathname: '/x', canGoBack: false })
    )
    expect(received).toEqual([{ _tag: 'RouteChanged', pathname: '/x', canGoBack: false }])
  })
})
