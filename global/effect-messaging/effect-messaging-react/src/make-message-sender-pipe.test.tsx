import { renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { NoContextException } from 'react-kitchen-sink'
import { describe, expect, test, vi } from 'vite-plus/test'

import { makeMessageSenderPipe } from './make-message-sender-pipe.tsx'
import { NavigationBridge, testBridges, type TestBridges } from './test-utils/test-bridges.ts'
import { makeRecordingSender } from './test-utils/test-recording-sender.ts'

const silenceReactErrorBoundary = (): (() => void) => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return (): void => {
    spy.mockRestore()
  }
}

// Note on rendering: `usePipeMessageSender` reads `handlerRef.current`
// eagerly at render time. After the first render, `useAsPipeMessageSender`'s
// `useEffect` writes the new sender — but the captured return is the
// pre-effect value (the default). Each test that needs to see the post-effect
// state calls `rerender()` once before reading, so the second render's eager
// read sees the value the first render's effect committed.

describe('makeMessageSenderPipe — examples', () => {
  test('sends before any sender is registered land on the default warn-and-drop handler', async () => {
    const { Provider, usePipeMessageSender } = makeMessageSenderPipe('Test', testBridges, 'Host')

    const { result } = renderHook(() => usePipeMessageSender(), {
      wrapper: ({ children }) => <Provider>{children}</Provider>,
    })

    // The default handler returns `Effect.logWarning(...)` which succeeds.
    const exit = await Effect.runPromise(Effect.exit(result.current({ _tag: 'HostBackRequested' })))
    expect(exit._tag).toBe('Success')
  })

  test('register → send forwards to the registered sender', async () => {
    const { Provider, useAsPipeMessageSender, usePipeMessageSender } = makeMessageSenderPipe(
      'Test',
      testBridges,
      'Host'
    )
    const { sender, received } = makeRecordingSender<TestBridges, 'Host'>()

    const { result, rerender } = renderHook(
      () => {
        useAsPipeMessageSender(sender)
        return usePipeMessageSender()
      },
      {
        wrapper: ({ children }) => <Provider>{children}</Provider>,
      }
    )
    // Flush the effect (eager read otherwise sees the default).
    rerender()

    await Effect.runPromise(result.current({ _tag: 'HostRequestedWebNavigation', path: '/x' }))
    expect(received).toEqual([{ _tag: 'HostRequestedWebNavigation', path: '/x' }])
  })

  test('re-register replaces the active sender', async () => {
    const { Provider, useAsPipeMessageSender, usePipeMessageSender } = makeMessageSenderPipe(
      'Test',
      testBridges,
      'Host'
    )
    const first = makeRecordingSender<TestBridges, 'Host'>()
    const second = makeRecordingSender<TestBridges, 'Host'>()

    const { result, rerender } = renderHook(
      ({ which }: { which: 'first' | 'second' }) => {
        useAsPipeMessageSender(which === 'first' ? first.sender : second.sender)
        return usePipeMessageSender()
      },
      {
        wrapper: ({ children }) => <Provider>{children}</Provider>,
        initialProps: { which: 'first' },
      }
    )

    // Flush the first effect, then send through it.
    rerender({ which: 'first' })
    await Effect.runPromise(result.current({ _tag: 'HostBackRequested' }))
    // Swap and flush again.
    rerender({ which: 'second' })
    rerender({ which: 'second' })
    await Effect.runPromise(result.current({ _tag: 'HostBackRequested' }))

    expect(first.received).toEqual([{ _tag: 'HostBackRequested' }])
    expect(second.received).toEqual([{ _tag: 'HostBackRequested' }])
  })

  test('usePipeMessageSender throws NoContextException outside Provider', () => {
    const { usePipeMessageSender } = makeMessageSenderPipe('Test', testBridges, 'Host')
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => usePipeMessageSender())).toThrow(NoContextException)
    } finally {
      restore()
    }
  })

  test('useAsPipeMessageSender throws NoContextException outside Provider', () => {
    const { useAsPipeMessageSender } = makeMessageSenderPipe('Test', testBridges, 'Host')
    const { sender } = makeRecordingSender<TestBridges, 'Host'>()
    const restore = silenceReactErrorBoundary()
    try {
      expect(() => renderHook(() => useAsPipeMessageSender(sender))).toThrow(NoContextException)
    } finally {
      restore()
    }
  })

  test('Provider has a displayName tagged with the factory name', () => {
    const { Provider } = makeMessageSenderPipe('TaggedPipe', testBridges, 'Host')
    expect(Provider.displayName).toBe('TaggedPipeMessageSenderPipeContext')
  })
})

describe('makeMessageSenderPipe — properties', () => {
  test('latest-wins: after a sequence of registrations, the next send routes to the most recently registered sender', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 6 }),
        async (registrationIds) => {
          const { Provider, useAsPipeMessageSender, usePipeMessageSender } = makeMessageSenderPipe(
            'Test',
            testBridges,
            'Host'
          )
          // Reuse one recording sender per id so we can assert which one
          // received the probe message after the sequence finishes.
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
            ({ activeId }: { activeId: number }) => {
              useAsPipeMessageSender(senderFor(activeId).sender)
              return usePipeMessageSender()
            },
            {
              wrapper: ({ children }) => <Provider>{children}</Provider>,
              initialProps: { activeId: registrationIds[0] ?? 0 },
            }
          )

          // Walk the registration sequence; each rerender writes to the
          // ref, the next read sees the previous write (effect flushes
          // between renders).
          for (const id of registrationIds) {
            rerender({ activeId: id })
          }
          // One more rerender flushes the final effect so the probe read
          // sees the last-written sender.
          rerender({ activeId: registrationIds[registrationIds.length - 1] ?? 0 })

          const expectedActive = registrationIds[registrationIds.length - 1] ?? 0
          await Effect.runPromise(result.current({ _tag: 'HostBackRequested' }))

          const active = senderFor(expectedActive)
          expect(active.received).toEqual([{ _tag: 'HostBackRequested' }])
          for (const [id, { received }] of senders) {
            if (id !== expectedActive) expect(received).toEqual([])
          }
          // Type-witness usage — `NavigationBridge` is the bridge whose
          // outbound messages we're routing; touching its name keeps the
          // import load-bearing and proves the bridge tuple ties together.
          expect(NavigationBridge.name).toBe('Navigation')
        }
      ),
      { numRuns: 25 }
    )
  })
})
