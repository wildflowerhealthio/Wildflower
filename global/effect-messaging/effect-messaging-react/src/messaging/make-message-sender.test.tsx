import { renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test, vi } from 'vite-plus/test'

import { makeMessageSender } from './make-message-sender.tsx'
import {
  hostOutboundMessageArb,
  outboundSequenceArb,
  webInboundMessageArb,
} from './test-arbitraries.ts'
import {
  GatekeeperBridge,
  NavigationBridge,
  testBridges,
  type TestBridges,
} from './test-bridges.ts'
import { makeRecordingSender } from './test-recording-sender.ts'

const silenceReactErrorBoundary = (): (() => void) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (): void => {
    spy.mockRestore()
  }
}

describe('makeMessageSender — examples', () => {
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

  test('useMessageSender returns a stable object across re-renders when inputs are stable', () => {
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

describe('makeMessageSender — properties', () => {
  test('preserves payload and order for any outbound sequence (Host side)', async () => {
    await fc.assert(
      fc.asyncProperty(outboundSequenceArb, async (messages) => {
        const { MessageSenderProvider, useMessageSender } = makeMessageSender(testBridges, 'Host')
        const { sender, received } = makeRecordingSender<TestBridges, 'Host'>()

        const { result } = renderHook(() => useMessageSender(NavigationBridge), {
          wrapper: ({ children }) => (
            <MessageSenderProvider sendMessage={sender}>{children}</MessageSenderProvider>
          ),
        })

        // Bridge.SendableMessage's runtime dispatch is by `_tag`; the
        // recording sender accepts any tagged shape. The slice-level type
        // narrowing is exercised in the example tests above — here we
        // assert the dispatch path is order-preserving and lossless.
        type SendInput = Parameters<typeof result.current.sendEffect>[0]
        await Effect.runPromise(
          Effect.forEach(
            messages,
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            (m) => result.current.sendEffect(m as SendInput),
            { discard: true }
          )
        )
        expect(received).toEqual(messages)
      }),
      { numRuns: 50 }
    )
  })

  test('preserves payload and order for any inbound sequence (Web side)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(webInboundMessageArb, { maxLength: 16 }), async (messages) => {
        const { MessageSenderProvider, useMessageSender } = makeMessageSender(testBridges, 'Web')
        const { sender, received } = makeRecordingSender<TestBridges, 'Web'>()

        const { result } = renderHook(() => useMessageSender(NavigationBridge), {
          wrapper: ({ children }) => (
            <MessageSenderProvider sendMessage={sender}>{children}</MessageSenderProvider>
          ),
        })

        await Effect.runPromise(
          Effect.forEach(messages, (m) => result.current.sendEffect(m), { discard: true })
        )
        expect(received).toEqual(messages)
      }),
      { numRuns: 50 }
    )
  })

  test('useMessageSender identity is stable across N renders for stable inputs', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (rerenderCount) => {
        const { MessageSenderProvider, useMessageSender } = makeMessageSender(testBridges, 'Host')
        const { sender } = makeRecordingSender<TestBridges, 'Host'>()

        const { result, rerender } = renderHook(() => useMessageSender(NavigationBridge), {
          wrapper: ({ children }) => (
            <MessageSenderProvider sendMessage={sender}>{children}</MessageSenderProvider>
          ),
        })
        const first = result.current
        for (let i = 0; i < rerenderCount; i++) rerender()
        return result.current === first
      }),
      { numRuns: 30 }
    )
  })

  test('individual outbound messages also round-trip through the dispatcher', async () => {
    await fc.assert(
      fc.asyncProperty(hostOutboundMessageArb, async (message) => {
        const { MessageSenderProvider, useMessageSender } = makeMessageSender(testBridges, 'Host')
        const { sender, received } = makeRecordingSender<TestBridges, 'Host'>()

        const { result } = renderHook(() => useMessageSender(NavigationBridge), {
          wrapper: ({ children }) => (
            <MessageSenderProvider sendMessage={sender}>{children}</MessageSenderProvider>
          ),
        })

        type SendInput = Parameters<typeof result.current.sendEffect>[0]
        await Effect.runPromise(
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          result.current.sendEffect(message as SendInput)
        )
        expect(received).toEqual([message])
      }),
      { numRuns: 50 }
    )
  })
})
