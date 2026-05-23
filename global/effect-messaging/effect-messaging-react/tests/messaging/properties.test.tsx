import { renderHook } from '@testing-library/react'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { makeMessaging } from '../../src/messaging/make-messaging.tsx'
import {
  NavigationBridge,
  inboundSequenceArb,
  lifecycleSequenceArb,
  makeRecordingSender,
  outboundSequenceArb,
  testBridges,
  type LifecycleEvent,
  type TestBridges,
} from '../fixtures/index.ts'

describe('property: sender preserves payload + order', () => {
  test('any sequence of outbound messages lands at the underlying sender unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(outboundSequenceArb, async (messages) => {
        const { MessageSenderProvider, useMessageSender } = makeMessaging(testBridges, 'Host')
        const { sender, received } = makeRecordingSender<TestBridges, 'Host'>()

        const { result } = renderHook(() => useMessageSender(NavigationBridge), {
          wrapper: ({ children }) => (
            <MessageSenderProvider sendMessage={sender}>{children}</MessageSenderProvider>
          ),
        })

        // Only NavigationBridge messages can be routed through that bridge's
        // hook (gatekeeper messages would type-fail at the slice level). For
        // the property, we trust the runtime dispatcher and route everything
        // through the context's wide sendEffect.
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
})

describe('property: receiver fanout exactness', () => {
  test('dispatching each message invokes every registered handler for that tag exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        inboundSequenceArb,
        fc.integer({ min: 1, max: 4 }),
        async (messages, handlerCount) => {
          const { MessageReceiverProvider, useMessageReceiver, useMessageDispatcher } =
            makeMessaging(testBridges, 'Host')

          // One slot per registered handler so we can assert each fired
          // exactly once per matching dispatch.
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
})

// Reduce a lifecycle event sequence to a single "currently active" id,
// matching the React semantics: each `register` overwrites the slot; each
// `unregister` clears it only if the id matches.
const reduceLifecycle = (es: ReadonlyArray<LifecycleEvent>): number | null => {
  let active: number | null = null
  for (const e of es) {
    if (e._tag === 'register') active = e.id
    else if (e._tag === 'unregister' && active === e.id) active = null
  }
  return active
}

describe('property: Hoisted latest-wins under any register/unregister sequence', () => {
  test('after any lifecycle sequence, the next send routes to the most recently registered, still-mounted sender (or drops if none)', async () => {
    await fc.assert(
      fc.asyncProperty(lifecycleSequenceArb, async (events) => {
        const expectedActive = reduceLifecycle(events)

        const { HoistedMessageSenderProvider, useRegisterMessageSender, useMessageSender } =
          makeMessaging(testBridges, 'Host')
        type Recording = ReturnType<typeof makeRecordingSender<TestBridges, 'Host'>>
        const senders = new Map<number, Recording>()
        const senderFor = (id: number): Recording => {
          const existing = senders.get(id)
          if (existing !== undefined) return existing
          const next = makeRecordingSender<TestBridges, 'Host'>()
          senders.set(id, next)
          return next
        }

        // The hook registers exactly one sender per render — the active id
        // computed by the same reducer. Stepping through events sequentially
        // via rerender mirrors the production register/unregister flow.
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

        // Drive the reducer step-by-step so each intermediate state mounts.
        let activeId: number | null = null
        for (const e of events) {
          if (e._tag === 'register') activeId = e.id
          else if (e._tag === 'unregister' && activeId === e.id) activeId = null
          rerender({ activeId })
        }
        expect(activeId).toBe(expectedActive)

        // Send a probe message; it must land at the expected active sender, or
        // be dropped (warn-and-resolve) when none is active.
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
