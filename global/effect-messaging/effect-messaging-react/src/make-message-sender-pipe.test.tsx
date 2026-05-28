import { render, renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { memo } from 'react'
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

// `usePipeMessageSender` returns a stable sender that reads
// `handlerRef.current` at suspend time, so a sender registered after the
// hook's first render is picked up on the next send without re-rendering.

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

    const { result } = renderHook(
      () => {
        useAsPipeMessageSender(sender)
        return usePipeMessageSender()
      },
      {
        wrapper: ({ children }) => <Provider>{children}</Provider>,
      }
    )

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

    await Effect.runPromise(result.current({ _tag: 'HostBackRequested' }))
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

  test('usePipeMessageSender returns an identity-stable function across re-renders', () => {
    const { Provider, usePipeMessageSender } = makeMessageSenderPipe('Test', testBridges, 'Host')

    const { result, rerender } = renderHook(() => usePipeMessageSender(), {
      wrapper: ({ children }) => <Provider>{children}</Provider>,
    })

    const first = result.current
    rerender()
    const second = result.current
    rerender()
    const third = result.current

    expect(Object.is(first, second)).toBe(true)
    expect(Object.is(second, third)).toBe(true)
  })

  test('a sender registered by a later-mounted child routes through a pipe captured before that child mounted, without re-rendering the consumer', async () => {
    const { Provider, useAsPipeMessageSender, usePipeMessageSender } = makeMessageSenderPipe(
      'Test',
      testBridges,
      'Host'
    )
    const { sender, received } = makeRecordingSender<TestBridges, 'Host'>()

    // Capture records its render count so we can assert it stays at 1 across
    // the test — proving the registering child mounting doesn't bounce the
    // consumer. The captured sender is held in a ref so even an accidental
    // re-render couldn't overwrite it with a fresh closure.
    let captureRenderCount = 0
    const capturedSenderRef: {
      current: BridgeTransport.MessageSender<TestBridges, 'Host'> | undefined
    } = { current: undefined }

    const Capture = memo((): null => {
      captureRenderCount += 1
      const senderFromHook = usePipeMessageSender()
      if (capturedSenderRef.current === undefined) {
        capturedSenderRef.current = senderFromHook
      }
      return null
    })
    Capture.displayName = 'Capture'

    const RegisterChild = (): null => {
      useAsPipeMessageSender(sender)
      return null
    }

    // The Provider's children are swapped via testing-library's `rerender`,
    // which re-runs the root element. `Capture` is wrapped in `memo` and
    // takes no props, so React skips re-rendering it on the second pass —
    // pinning the contract that the captured sender continues to route
    // correctly without the consumer ever re-rendering.
    const { rerender } = render(
      <Provider>
        <Capture />
      </Provider>
    )

    expect(captureRenderCount).toBe(1)
    expect(capturedSenderRef.current).toBeDefined()
    const captured = capturedSenderRef.current
    if (captured === undefined) throw new Error('capturedSender not set')

    rerender(
      <Provider>
        <Capture />
        <RegisterChild />
      </Provider>
    )

    // Capture should not have re-rendered — its position in the tree is
    // unchanged and its props are unchanged.
    expect(captureRenderCount).toBe(1)

    await Effect.runPromise(captured({ _tag: 'HostBackRequested' }))
    expect(received).toEqual([{ _tag: 'HostBackRequested' }])
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
          // ref. The probe sender reads `.current` lazily so the last
          // write is what the next send routes to.
          for (const id of registrationIds) {
            rerender({ activeId: id })
          }

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
      { numRuns: numRunsFor(25) }
    )
  })
})
