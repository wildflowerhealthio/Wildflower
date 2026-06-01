import { Effect, Option, Queue, Schema } from 'effect'
import * as fc from 'fast-check'
import { LoggingLayerTest, numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import * as BridgeTransport from './bridge-transport.ts'
import * as Bridge from './bridge.ts'
import * as TestPlatformAdapterLayer from './test-platform-adapter-layer.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))

// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
const makeBridges = () => {
  const NavigationLike = Bridge.make({
    name: 'NavLike',
    hostToWeb: [['Ping', Ping]] as const,
    webToHost: [['Pong', Pong]] as const,
  })
  return { NavigationLike }
}

const encodePing = (value: number): string => Schema.encodeSync(Ping)({ _tag: 'Ping', value })

describe('BridgeTransport.make — duplicate outbound-tag throw', () => {
  test('two bridges declaring the same outbound tag fail synchronously', async () => {
    const A = Bridge.make({
      name: 'A',
      hostToWeb: [['Ping', Ping]] as const,
      webToHost: [] as const,
    })
    const B = Bridge.make({
      name: 'B',
      hostToWeb: [['Ping', Ping]] as const,
      webToHost: [] as const,
    })
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
    const program = Effect.scoped(
      BridgeTransport.make({
        bridges: [A, B] as const,
        handlers: [{}, {}],
        side: 'Host',
      }).pipe(Effect.provide(adapterLayer))
    )
    await expect(Effect.runPromise(program)).rejects.toThrow(/duplicate outbound tag "Ping"/)
  })
})

describe('BridgeTransport — parking, replay, and decode resilience', () => {
  test('a message whose tag has no handler is parked, then replayed when registerHandlers covers it', async () => {
    // Schema acceptance proves the tag is a known inbound message, so an
    // unhandled-but-valid Ping is held — not dropped — until a covering
    // handler lands. This is the cold-start guarantee the BridgedWebView
    // consumer leans on: messages can arrive before React mounts the
    // handler that owns them.
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
    // The typed handler record requires every inbound tag; this test
    // deliberately registers none. TS rejects the direct assertion (the
    // empty record and the full record don't structurally overlap), so the
    // intentionally empty set is cast through `unknown`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const noHandlers = [{}] as unknown as Bridge.HandlersByBridge<
      readonly [typeof NavigationLike],
      'Web'
    >
    await Effect.runPromise(
      Effect.gen(function* () {
        const results = yield* Queue.unbounded<number>()
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          // No Ping handler yet — the inbound Ping has nowhere to go.
          handlers: noHandlers,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))

        yield* transport.enqueue(encodePing(42))
        // Re-registering the (still empty) handler set is a pure inbox
        // barrier: it sits behind the Ping in FIFO order, so when it
        // resolves the Ping has been processed — and parked.
        yield* transport.registerHandlers(noHandlers)
        expect(yield* Queue.poll(results)).toEqual(Option.none())

        // Installing a covering handler replays the parked Ping in arrival order.
        yield* transport.registerHandlers([
          { Ping: ({ value }) => Queue.offer(results, value).pipe(Effect.asVoid) },
        ])
        expect(yield* Queue.take(results)).toBe(42)
      }).pipe(Effect.scoped)
    )
  })

  test('a malformed inbound string logs a decode warning and the dispatch fiber survives', async () => {
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const results = yield* Queue.unbounded<number>()
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: ({ value }) => Queue.offer(results, value).pipe(Effect.asVoid) }],
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))

        // Garbage in: decode fails, the fiber logs and keeps going.
        yield* transport.enqueue('not json at all')
        // A subsequent valid message still dispatches — proof the fiber
        // wasn't taken down by the decode failure.
        yield* transport.enqueue(encodePing(7))
        expect(yield* Queue.take(results)).toBe(7)
      }).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toContainEqual(
            expect.objectContaining({
              level: 'WARN',
              // oxlint-disable-next-line typescript/no-unsafe-assignment
              message: expect.stringContaining('[effect-messaging] failed to decode message'),
            })
          )
        }),
        Effect.scoped
      )
    )
  })
})

describe('BridgeTransport.make — live-attachment path', () => {
  test('attachBareSender callback feeds the inbox and routes through the dispatch fiber', async () => {
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer, liveBareSenderRef } = TestPlatformAdapterLayer.make({
      captureBareSenderLive: true,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const results = yield* Queue.unbounded<number>()
        yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: ({ value }) => Queue.offer(results, value).pipe(Effect.asVoid) }],
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        if (liveBareSenderRef.current === null) throw new Error('liveBareSenderRef not captured')
        yield* liveBareSenderRef.current(encodePing(99))
        expect(yield* Queue.take(results)).toBe(99)
      }).pipe(Effect.scoped)
    )
  })

  test('scope close detaches the live enqueue', async () => {
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer, liveBareSenderRef } = TestPlatformAdapterLayer.make({
      captureBareSenderLive: true,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: () => Effect.void }],
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        expect(liveBareSenderRef.current).not.toBeNull()
      }).pipe(Effect.scoped)
    )
    expect(liveBareSenderRef.current).toBeNull()
  })
})

describe('BridgeTransport.registerHandlers — in-place handler swap', () => {
  test('replaces per-tag handlers on the next inbound message without rebuilding the transport', async () => {
    // Cold-start regression guard: before in-place swaps, a fresh handler
    // set on the host required `BridgeTransport.make` to re-run from
    // scratch (queues, dispatch fiber, peerReady — all torn down and
    // recreated). The BridgedWebView consumer relied on that, which tore
    // the WebView down with it and flashed the loader. `registerHandlers`
    // swaps the handler map in place via the internal `Ref`; the queues,
    // dispatch fiber, schemas, and outbound senders all persist.
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const results = yield* Queue.unbounded<{ via: 'first' | 'second'; value: number }>()
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          handlers: [
            {
              Ping: ({ value }) =>
                Queue.offer(results, { via: 'first', value }).pipe(Effect.asVoid),
            },
          ],
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))

        yield* transport.enqueue(encodePing(1))
        // Awaiting the first result sequences the swap strictly after the
        // first dispatch — the Ping above ran under `first`.
        expect(yield* Queue.take(results)).toEqual({ via: 'first', value: 1 })

        yield* transport.registerHandlers([
          {
            Ping: ({ value }) => Queue.offer(results, { via: 'second', value }).pipe(Effect.asVoid),
          },
        ])
        yield* transport.enqueue(encodePing(2))
        expect(yield* Queue.take(results)).toEqual({ via: 'second', value: 2 })
      }).pipe(Effect.scoped)
    )
  })

  test('preserves the send gate across swaps (host sends still flow after a handler swap)', async () => {
    // `peerReady` is captured once at make time and is never rebuilt by
    // `registerHandlers` — the transport has no API to do so. A host that
    // already received `__Ready` keeps its open gate across swaps, so a
    // send issued afterwards drains rather than re-gating on a fresh deferred.
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer, sentQueue } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          handlers: [{ Pong: () => Effect.void }],
          side: 'Host',
        }).pipe(Effect.provide(adapterLayer))

        // Open the gate via the inbound __Ready, then swap handlers. The
        // register is a barrier behind the __Ready message, so on return
        // `peerReady` is resolved.
        yield* transport.enqueue('{"_tag":"__Ready"}')
        yield* transport.registerHandlers([{ Pong: () => Effect.void }])

        yield* transport.sendMessage({ _tag: 'Ping', value: 5 })
        const sent = yield* Queue.take(sentQueue)
        expect(JSON.parse(sent)).toMatchObject({ _tag: 'Ping', value: 5 })
      }).pipe(Effect.scoped)
    )
  })

  test('rapid back-to-back registerHandlers calls converge on the last set (no race, no leak)', async () => {
    // Each `registerHandlers` awaits its `done` before the next runs, so
    // the register items process in call order and the final handler map
    // matches the last set. Drives a sequence of N handler records each
    // tagged with its position, installs them sequentially, then
    // dispatches one Ping and asserts only the last handler ran.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
        const { NavigationLike } = makeBridges()
        const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
        await Effect.runPromise(
          Effect.gen(function* () {
            const observed = yield* Queue.unbounded<number>()
            const transport = yield* BridgeTransport.make({
              bridges: [NavigationLike] as const,
              handlers: [{ Ping: () => Queue.offer(observed, 0).pipe(Effect.asVoid) }],
              side: 'Web',
            }).pipe(Effect.provide(adapterLayer))

            for (let i = 1; i < n; i++) {
              yield* transport.registerHandlers([
                { Ping: () => Queue.offer(observed, i).pipe(Effect.asVoid) },
              ])
            }

            yield* transport.enqueue(encodePing(1))
            expect(yield* Queue.take(observed)).toBe(n - 1)
          }).pipe(Effect.scoped)
        )
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('BridgeTransport.make — initial-message replay', () => {
  test('drains and dispatches initial messages on construction', async () => {
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make({
      initialMessages: [encodePing(7)],
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const results = yield* Queue.unbounded<number>()
        yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: ({ value }) => Queue.offer(results, value).pipe(Effect.asVoid) }],
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        expect(yield* Queue.take(results)).toBe(7)
      }).pipe(Effect.scoped)
    )
  })
})

describe('BridgeTransport.make — __Ready handshake', () => {
  test('Host sends buffer in the outbox until __Ready, then flush in order', async () => {
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer, sentQueue } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          handlers: [{ Pong: () => Effect.void }],
          side: 'Host',
        }).pipe(Effect.provide(adapterLayer))

        // sendMessage no longer suspends — it offers to the outbox and
        // returns. The pump is gated on `peerReady`, which the host hasn't
        // received, so nothing has flushed yet.
        yield* transport.sendMessage({ _tag: 'Ping', value: 1 })
        expect(yield* Queue.poll(sentQueue)).toEqual(Option.none())

        // The inbound __Ready resolves `peerReady`; the buffered send drains.
        yield* transport.enqueue('{"_tag":"__Ready"}')
        const sent = yield* Queue.take(sentQueue)
        expect(JSON.parse(sent)).toEqual({ _tag: 'Ping', value: 1 })
      }).pipe(Effect.scoped)
    )
  })

  test('Web sendMessage flows without an external Ready (the web self-posts at make)', async () => {
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer, sentQueue } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: () => Effect.void }],
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        yield* transport.sendMessage({ _tag: 'Pong', reply: 'hi' })
        const sent = yield* Queue.take(sentQueue)
        expect(JSON.parse(sent)).toEqual({ _tag: 'Pong', reply: 'hi' })
      }).pipe(Effect.scoped)
    )
  })

  test('Web signalReady posts __Ready via bareSender', async () => {
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: () => Effect.void }],
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        yield* transport.signalReady
        expect(sentSink).toEqual(['{"_tag":"__Ready"}'])
      }).pipe(Effect.scoped)
    )
  })

  test('Host signalReady is a no-op', async () => {
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          handlers: [{ Pong: () => Effect.void }],
          side: 'Host',
        }).pipe(Effect.provide(adapterLayer))
        yield* transport.signalReady
        expect(sentSink).toHaveLength(0)
      }).pipe(Effect.scoped)
    )
  })
})

describe('BridgeTransport.make — queue lifecycle', () => {
  test('property: late enqueues after scope close drop without throwing', async () => {
    const { NavigationLike } = makeBridges()
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { maxLength: 20 }),
        async (lateMessages: ReadonlyArray<string>) => {
          const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
          // Return `enqueue` out of the scoped program so it's captured with
          // its concrete type — by the time the value lands the scope has
          // closed, which is exactly the post-close state under test.
          const capturedEnqueue = await Effect.runPromise(
            Effect.gen(function* () {
              const transport = yield* BridgeTransport.make({
                bridges: [NavigationLike] as const,
                handlers: [{ Ping: () => Effect.void }],
                side: 'Web',
              }).pipe(Effect.provide(adapterLayer))
              return transport.enqueue
            }).pipe(Effect.scoped)
          )
          // The inbox is shut down post scope-close; each offer is dropped
          // via `Effect.ignore`, so running every late enqueue resolves
          // cleanly rather than throwing.
          for (const msg of lateMessages) {
            await Effect.runPromise(capturedEnqueue(msg))
          }
        }
      ),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })
})
