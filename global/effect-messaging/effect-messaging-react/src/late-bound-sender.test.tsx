import { renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import { describe, expect, test } from 'vite-plus/test'
import { useLateBoundSender } from './late-bound-sender.ts'
import type { TestBridges } from './test-utils/test-bridges.ts'

type TestSender = BridgeTransport.MessageSender<TestBridges, 'HostToWeb'>

describe('useLateBoundSender', () => {
  test('reads the ref at send time — a sender registered later is used', async () => {
    const calls: string[] = []
    const senderRef: { current: TestSender } = {
      current: () => Effect.sync(() => calls.push('default')),
    }
    const { result } = renderHook(() => useLateBoundSender(senderRef))

    // Registered after the hook's first render.
    senderRef.current = (message) => Effect.sync(() => calls.push(message._tag))
    await Effect.runPromise(result.current({ _tag: 'HostBackRequested' }))
    expect(calls).toEqual(['HostBackRequested'])
  })

  test('returns an identity-stable function across renders', () => {
    const senderRef: { current: TestSender } = { current: () => Effect.void }
    const { result, rerender } = renderHook(() => useLateBoundSender(senderRef))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
