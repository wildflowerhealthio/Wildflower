import { Effect, Option, Queue, Schema } from 'effect'
import * as fc from 'fast-check'
import { LoggingLayerTest, numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import * as BridgeTransport from './bridge-transport.ts'
import * as Bridge from './bridge.ts'
import * as TestPlatformAdapterLayer from './test-platform-adapter-layer.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))
const Tick = Schema.parseJson(Schema.TaggedStruct('Tick', {}))

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
const encodeTick = (): string => Schema.encodeSync(Tick)({ _tag: 'Tick' })

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
      BridgeTransport.makeHostTransport({
        bridges: [A, B] as const,
        handlers: [{}, {}],
      }).pipe(Effect.provide(adapterLayer))
    )
    await expect(Effect.runPromise(program)).rejects.toThrow(/duplicate outbound tag\(s\) "Ping"/)
  })
})

describe('BridgeTransport — unhandled-tag drop and decode resilience', () => {
  test('a valid inbound message with no registered handler logs a warning and is dropped', async () => {
    // Parking is gone: a schema-valid tag with no handler is logged-and-
    // dropped, not held. A second inbound tag (Tick) with a real handler is
    // a FIFO sentinel — once it fires we know the handler-less Ping ahead of
    // it was already processed (and dropped).
    const TwoInbound = Bridge.make({
      name: 'TwoInbound',
      hostToWeb: [
        ['Ping', Ping],
        ['Tick', Tick],
      ] as const,
      webToHost: [] as const,
    })
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const ticked = yield* Queue.unbounded<void>()
        // Register Tick only — Ping has no handler. The typed record requires
        // every inbound tag, so the deliberately partial set is cast through
        // `unknown` (partial and full records don't structurally overlap).
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const tickOnly = [
          { Tick: () => Queue.offer(ticked, undefined).pipe(Effect.asVoid) },
        ] as unknown as Bridge.HandlersByBridge<readonly [typeof TwoInbound], 'HostToWeb'>
        const transport = yield* BridgeTransport.makeWebTransport({
          bridges: [TwoInbound] as const,
          handlers: tickOnly,
        }).pipe(Effect.provide(adapterLayer))

        // Ping has no handler → dropped. Tick rides the same FIFO inbox behind
        // it, so taking its signal proves the Ping was processed (dropped) first.
        yield* transport.enqueue(encodePing(42))
        yield* transport.enqueue(encodeTick())
        yield* Queue.take(ticked)
      }).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toContainEqual(
            expect.objectContaining({
              level: 'WARN',
              // oxlint-disable-next-line typescript/no-unsafe-assignment
              message: expect.stringContaining(
                '[effect-messaging] no handler for inbound tag "Ping"'
              ),
            })
          )
        }),
        Effect.scoped
      )
    )
  })

  test('a malformed inbound string logs a decode warning and the dispatch fiber survives', async () => {
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const results = yield* Queue.unbounded<number>()
        const transport = yield* BridgeTransport.makeWebTransport({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: ({ value }) => Queue.offer(results, value).pipe(Effect.asVoid) }],
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
        yield* BridgeTransport.makeWebTransport({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: ({ value }) => Queue.offer(results, value).pipe(Effect.asVoid) }],
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
        yield* BridgeTransport.makeWebTransport({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: () => Effect.void }],
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
        const transport = yield* BridgeTransport.makeWebTransport({
          bridges: [NavigationLike] as const,
          handlers: [
            {
              Ping: ({ value }) =>
                Queue.offer(results, { via: 'first', value }).pipe(Effect.asVoid),
            },
          ],
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
        const transport = yield* BridgeTransport.makeHostTransport({
          bridges: [NavigationLike] as const,
          handlers: [{ Pong: () => Effect.void }],
        }).pipe(Effect.provide(adapterLayer))

        // The inbound __Ready resolves `peerReady`; the swap is an in-place
        // `Ref.set` that never touches the gate. The send below buffers in the
        // outbox and drains once the dispatch fiber has processed __Ready —
        // `Queue.take` below blocks until that flush lands.
        yield* transport.enqueue('{"_tag":"__Ready"}')
        yield* transport.registerHandlers([{ Pong: () => Effect.void }])

        yield* transport.sendMessage({ _tag: 'Ping', value: 5 })
        const sent = yield* Queue.take(sentQueue)
        expect(JSON.parse(sent)).toMatchObject({ _tag: 'Ping', value: 5 })
      }).pipe(Effect.scoped)
    )
  })

  test('rapid concurrent registerHandlers calls converge on one registered handler (no race, no leak)', async () => {
    // Forks N `registerHandlers` Effects concurrently — each one
    // performs an in-place `Ref.set`, so the final handler map is the
    // one written by whichever fiber lands its set last. Concurrency
    // makes "which one" nondeterministic, but the convergence claim is
    // load-bearing: after all registrations settle, a subsequent
    // dispatch must route to *some* registered handler (not a torn
    // intermediate state, not a dropped registration). Asserts the
    // observed value is one of the N indices and that exactly one
    // handler ran.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
        const { NavigationLike } = makeBridges()
        const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
        await Effect.runPromise(
          Effect.gen(function* () {
            const observed = yield* Queue.unbounded<number>()
            const transport = yield* BridgeTransport.makeWebTransport({
              bridges: [NavigationLike] as const,
              handlers: [{ Ping: () => Queue.offer(observed, 0).pipe(Effect.asVoid) }],
            }).pipe(Effect.provide(adapterLayer))

            const indices = Array.from({ length: n - 1 }, (_, k) => k + 1)
            yield* Effect.forEach(
              indices,
              (i) =>
                transport.registerHandlers([
                  { Ping: () => Queue.offer(observed, i).pipe(Effect.asVoid) },
                ]),
              { concurrency: 'unbounded' }
            )

            yield* transport.enqueue(encodePing(1))
            const winner = yield* Queue.take(observed)
            expect(winner).toBeGreaterThanOrEqual(0)
            expect(winner).toBeLessThan(n)
            // Exactly one handler ran: a second Ping decoded against the
            // same Ref should also resolve to a known index without
            // hanging — pin that the queue isn't draining stale offers.
            expect(yield* Queue.size(observed)).toBe(0)
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
        yield* BridgeTransport.makeWebTransport({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: ({ value }) => Queue.offer(results, value).pipe(Effect.asVoid) }],
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
        const transport = yield* BridgeTransport.makeHostTransport({
          bridges: [NavigationLike] as const,
          handlers: [{ Pong: () => Effect.void }],
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

  test('Web sendMessage flows without an external Ready (its send gate is open from the start)', async () => {
    const { NavigationLike } = makeBridges()
    const { layer: adapterLayer, sentQueue } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.makeWebTransport({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: () => Effect.void }],
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
        const transport = yield* BridgeTransport.makeWebTransport({
          bridges: [NavigationLike] as const,
          handlers: [{ Ping: () => Effect.void }],
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
        const transport = yield* BridgeTransport.makeHostTransport({
          bridges: [NavigationLike] as const,
          handlers: [{ Pong: () => Effect.void }],
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
              const transport = yield* BridgeTransport.makeWebTransport({
                bridges: [NavigationLike] as const,
                handlers: [{ Ping: () => Effect.void }],
              }).pipe(Effect.provide(adapterLayer))
              return transport.enqueue
            }).pipe(Effect.scoped)
          )
          // The inbox is shut down post scope-close; each offer fails with an
          // interrupt cause that `catchAllCause` swallows, so running every
          // late enqueue resolves cleanly rather than throwing.
          for (const msg of lateMessages) {
            await Effect.runPromise(capturedEnqueue(msg))
          }
        }
      ),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })

  test('property: late sendMessage after scope close drops without throwing', async () => {
    const { NavigationLike } = makeBridges()
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { maxLength: 20 }),
        async (replies: ReadonlyArray<string>) => {
          const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
          // Capture `sendMessage` out of the scoped program; by the time the
          // value lands the scope (and the outbox) has closed.
          const capturedSend = await Effect.runPromise(
            Effect.gen(function* () {
              const transport = yield* BridgeTransport.makeWebTransport({
                bridges: [NavigationLike] as const,
                handlers: [{ Ping: () => Effect.void }],
              }).pipe(Effect.provide(adapterLayer))
              return transport.sendMessage
            }).pipe(Effect.scoped)
          )
          // The outbox is shut down post scope-close; the offer fails with an
          // interrupt cause that `catchAllCause` swallows. A bare `Effect.ignore`
          // touches only the typed-error channel and would let the interrupt
          // through, rejecting here — so this guards that regression.
          for (const reply of replies) {
            await Effect.runPromise(capturedSend({ _tag: 'Pong', reply }))
          }
        }
      ),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })
})
