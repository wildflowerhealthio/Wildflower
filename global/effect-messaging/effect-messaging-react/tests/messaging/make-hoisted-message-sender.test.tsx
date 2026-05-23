import { renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test } from 'vite-plus/test'

import { makeHoistedMessageSender } from '../../src/messaging/make-hoisted-message-sender.tsx'
import { makeMessageSender } from '../../src/messaging/make-message-sender.tsx'
import {
  NavigationBridge,
  makeRecordingSender,
  silenceReactErrorBoundary,
  testBridges,
  type TestBridges,
} from '../fixtures/index.ts'

const buildPair = (): ReturnType<typeof makeMessageSender<TestBridges, 'Host'>> &
  ReturnType<typeof makeHoistedMessageSender<TestBridges, 'Host'>> => {
  const sender = makeMessageSender(testBridges, 'Host')
  const hoisted = makeHoistedMessageSender(testBridges, 'Host', sender.Context)
  return { ...sender, ...hoisted }
}

describe('makeHoistedMessageSender', () => {
  test('sends before any sender is registered log-warn and drop (no throw)', async () => {
    const { HoistedMessageSenderProvider, useMessageSender } = buildPair()

    const { result } = renderHook(() => useMessageSender(NavigationBridge), {
      wrapper: ({ children }) => (
        <HoistedMessageSenderProvider>{children}</HoistedMessageSenderProvider>
      ),
    })

    const exit = await Effect.runPromise(
      Effect.exit(result.current.sendEffect({ _tag: 'HostBackRequested' }))
    )
    expect(exit._tag).toBe('Success')
  })

  test('register → send forwards to the registered sender', async () => {
    const { HoistedMessageSenderProvider, useRegisterMessageSender, useMessageSender } = buildPair()
    const { sender, received } = makeRecordingSender<TestBridges, 'Host'>()

    const { result } = renderHook(
      () => {
        useRegisterMessageSender(sender)
        return useMessageSender(NavigationBridge)
      },
      {
        wrapper: ({ children }) => (
          <HoistedMessageSenderProvider>{children}</HoistedMessageSenderProvider>
        ),
      }
    )

    await Effect.runPromise(
      result.current.sendEffect({ _tag: 'HostRequestedWebNavigation', path: '/x' })
    )
    expect(received).toEqual([{ _tag: 'HostRequestedWebNavigation', path: '/x' }])
  })

  test('re-register replaces the active sender', async () => {
    const { HoistedMessageSenderProvider, useRegisterMessageSender, useMessageSender } = buildPair()
    const first = makeRecordingSender<TestBridges, 'Host'>()
    const second = makeRecordingSender<TestBridges, 'Host'>()

    const { result, rerender } = renderHook(
      ({ which }: { which: 'first' | 'second' }) => {
        useRegisterMessageSender(which === 'first' ? first.sender : second.sender)
        return useMessageSender(NavigationBridge)
      },
      {
        wrapper: ({ children }) => (
          <HoistedMessageSenderProvider>{children}</HoistedMessageSenderProvider>
        ),
        initialProps: { which: 'first' },
      }
    )
    await Effect.runPromise(result.current.sendEffect({ _tag: 'HostBackRequested' }))
    rerender({ which: 'second' })
    await Effect.runPromise(result.current.sendEffect({ _tag: 'HostBackRequested' }))

    expect(first.received).toEqual([{ _tag: 'HostBackRequested' }])
    expect(second.received).toEqual([{ _tag: 'HostBackRequested' }])
  })

  test('cleanup-only-if-ours: re-register, then unmount the OLD registrant — slot keeps the new one', async () => {
    const { HoistedMessageSenderProvider, useRegisterMessageSender, useMessageSender } = buildPair()
    const first = makeRecordingSender<TestBridges, 'Host'>()
    const second = makeRecordingSender<TestBridges, 'Host'>()

    // Single component swaps which sender it registers across re-renders. The
    // cleanup runs against the PREVIOUS sender on each rerender — but the
    // guard `if (ref.current === sender) ref.current = null` means the
    // cleanup for `first` (which no longer matches the slot's current value)
    // doesn't clobber `second`.
    const { result, rerender } = renderHook(
      ({ which }: { which: 'first' | 'second' }) => {
        useRegisterMessageSender(which === 'first' ? first.sender : second.sender)
        return useMessageSender(NavigationBridge)
      },
      {
        wrapper: ({ children }) => (
          <HoistedMessageSenderProvider>{children}</HoistedMessageSenderProvider>
        ),
        initialProps: { which: 'first' },
      }
    )

    rerender({ which: 'second' })
    // After the swap, sends must reach `second` — not be dropped because
    // `first`'s cleanup raced and nulled the slot.
    await Effect.runPromise(result.current.sendEffect({ _tag: 'HostBackRequested' }))
    expect(second.received).toEqual([{ _tag: 'HostBackRequested' }])
    expect(first.received).toEqual([])
  })

  test('unmount with no replacement clears the slot — subsequent sends drop', async () => {
    const { HoistedMessageSenderProvider, useRegisterMessageSender, useMessageSender } = buildPair()
    const { sender, received } = makeRecordingSender<TestBridges, 'Host'>()

    const { result, rerender } = renderHook(
      ({ mounted }: { mounted: boolean }) => {
        if (mounted) useRegisterMessageSender(sender)
        return useMessageSender(NavigationBridge)
      },
      {
        wrapper: ({ children }) => (
          <HoistedMessageSenderProvider>{children}</HoistedMessageSenderProvider>
        ),
        initialProps: { mounted: true },
      }
    )

    await Effect.runPromise(result.current.sendEffect({ _tag: 'HostBackRequested' }))
    rerender({ mounted: false })
    const exit = await Effect.runPromise(
      Effect.exit(result.current.sendEffect({ _tag: 'HostBackRequested' }))
    )
    expect(exit._tag).toBe('Success')
    expect(received).toEqual([{ _tag: 'HostBackRequested' }])
  })

  test('useRegisterMessageSender throws NoContextException outside Hoisted provider', () => {
    const { useRegisterMessageSender } = buildPair()
    const { sender } = makeRecordingSender<TestBridges, 'Host'>()
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => useRegisterMessageSender(sender))).toThrow(NoContextException)
    } finally {
      restore()
    }
  })
})
