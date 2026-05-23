import { renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test, vi } from 'vite-plus/test'

import { makeHoistedMessageSender } from './make-hoisted-message-sender.tsx'
import { makeMessageSender } from './make-message-sender.tsx'
import { lifecycleSequenceArb, type LifecycleEvent } from './test-arbitraries.ts'
import { NavigationBridge, testBridges, type TestBridges } from './test-bridges.ts'
import { makeRecordingSender } from './test-recording-sender.ts'

const silenceReactErrorBoundary = (): (() => void) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (): void => {
    spy.mockRestore()
  }
}

const buildPair = (): ReturnType<typeof makeMessageSender<TestBridges, 'Host'>> &
  ReturnType<typeof makeHoistedMessageSender<TestBridges, 'Host'>> => {
  const sender = makeMessageSender(testBridges, 'Host')
  const hoisted = makeHoistedMessageSender(testBridges, 'Host', sender.Context)
  return { ...sender, ...hoisted }
}

// Reduce a lifecycle event sequence to the active id under the React
// semantics: each `register` overwrites the slot; each `unregister` clears
// the slot only if the id matches.
const reduceLifecycle = (es: ReadonlyArray<LifecycleEvent>): number | null => {
  let active: number | null = null
  for (const e of es) {
    if (e._tag === 'register') active = e.id
    else if (e._tag === 'unregister' && active === e.id) active = null
  }
  return active
}

describe('makeHoistedMessageSender — examples', () => {
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

  test('cleanup-only-if-ours: re-register, then unmount the OLD registrant — slot keeps the new one', async () => {
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

    rerender({ which: 'second' })
    await Effect.runPromise(result.current.sendEffect({ _tag: 'HostBackRequested' }))
    expect(second.received).toEqual([{ _tag: 'HostBackRequested' }])
    expect(first.received).toEqual([])
  })

  test('unmount with no replacement clears the slot — subsequent sends drop', async () => {
    const { HoistedMessageSenderProvider, useRegisterMessageSender, useMessageSender } = buildPair()
    const { sender, received } = makeRecordingSender<TestBridges, 'Host'>()

    const { result, rerender } = renderHook(
      ({ mounted }: { mounted: boolean }) => {
        // Toggle by passing null when unmounted — keeps the hook order stable.
        useRegisterMessageSender(mounted ? sender : null)
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

describe('makeHoistedMessageSender — properties', () => {
  test('latest-wins: after any register/unregister sequence, the next send routes to the most recently registered, still-active sender (or drops if none)', async () => {
    await fc.assert(
      fc.asyncProperty(lifecycleSequenceArb, async (events) => {
        const expectedActive = reduceLifecycle(events)
        const { HoistedMessageSenderProvider, useRegisterMessageSender, useMessageSender } =
          buildPair()
        type Recording = ReturnType<typeof makeRecordingSender<TestBridges, 'Host'>>
        const senders = new Map<number, Recording>()
        const senderFor = (id: number): Recording => {
          const existing = senders.get(id)
          if (existing !== undefined) return existing
          const next = makeRecordingSender<TestBridges, 'Host'>()
          senders.set(id, next)
          return next
        }

        const { result, rerender } = renderHook(
          ({ activeId }: { activeId: number | null }) => {
            useRegisterMessageSender(activeId === null ? null : senderFor(activeId).sender)
            return useMessageSender(NavigationBridge)
          },
          {
            wrapper: ({ children }) => (
              <HoistedMessageSenderProvider>{children}</HoistedMessageSenderProvider>
            ),
            initialProps: { activeId: null as number | null },
          }
        )

        // Step through events so each intermediate state mounts in the
        // production register/unregister order.
        let activeId: number | null = null
        for (const e of events) {
          if (e._tag === 'register') activeId = e.id
          else if (e._tag === 'unregister' && activeId === e.id) activeId = null
          rerender({ activeId })
        }
        expect(activeId).toBe(expectedActive)

        await Effect.runPromise(result.current.sendEffect({ _tag: 'HostBackRequested' }))
        if (expectedActive === null) {
          for (const { received } of senders.values()) {
            expect(received).toEqual([])
          }
        } else {
          const active = senderFor(expectedActive)
          expect(active.received).toEqual([{ _tag: 'HostBackRequested' }])
          for (const [id, { received }] of senders) {
            if (id !== expectedActive) expect(received).toEqual([])
          }
        }
      }),
      { numRuns: 30 }
    )
  })
})
