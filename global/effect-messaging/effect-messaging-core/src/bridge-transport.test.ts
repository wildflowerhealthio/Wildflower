import { Effect, Schema } from 'effect'
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
    const aLayer = A.Host.ReceiverLayer({})
    const bLayer = B.Host.ReceiverLayer({})
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
    const program = Effect.scoped(
      BridgeTransport.make({
        bridges: [A, B] as const,
        layers: [aLayer, bLayer] as const,
        side: 'Host',
      }).pipe(Effect.provide(adapterLayer))
    )
    await expect(Effect.runPromise(program)).rejects.toThrow(/duplicate outbound tag "Ping"/)
  })
})

describe('BridgeTransport.make — internal-error variant', () => {
  test('logs an Internal warning when a bridge handler is missing for an indexed tag', async () => {
    // Emulates wiring drift: tag indexes, schema decodes, but `handlers[_tag]` is undefined.
    const { NavigationLike } = makeBridges()
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const layer = NavigationLike.Web.ReceiverLayer({ Ping: undefined } as never)
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        yield* transport.enqueue(Schema.encodeSync(Ping)({ _tag: 'Ping', value: 1 }))
        yield* transport.flushed
      }).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toEqual([
            expect.objectContaining({
              level: 'WARN',
              // oxlint-disable-next-line typescript/no-unsafe-assignment
              message: expect.stringContaining(
                '[effect-messaging] internal dispatch invariant violated for live tag "Ping"'
              ),
            }),
          ])
        }),
        Effect.scoped
      )
    )
  })
})

describe('BridgeTransport.make — live-attachment path', () => {
  test('attachBareSender callback receives enqueue and routes through the dispatch fiber', async () => {
    const { NavigationLike } = makeBridges()
    let pingCalls = 0
    const layer = NavigationLike.Web.ReceiverLayer({
      Ping: () => Effect.sync(() => (pingCalls += 1)),
    })
    const { layer: adapterLayer, liveBareSenderRef } = TestPlatformAdapterLayer.make({
      captureBareSenderLive: true,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        if (liveBareSenderRef.current === null) throw new Error('liveBareSenderRef not captured')
        yield* liveBareSenderRef.current(Schema.encodeSync(Ping)({ _tag: 'Ping', value: 99 }))
        yield* transport.flushed
        expect(pingCalls).toBe(1)
      }).pipe(Effect.scoped)
    )
  })

  test('scope close detaches the live enqueue', async () => {
    const { NavigationLike } = makeBridges()
    const layer = NavigationLike.Web.ReceiverLayer({ Ping: () => Effect.void })
    const { layer: adapterLayer, liveBareSenderRef } = TestPlatformAdapterLayer.make({
      captureBareSenderLive: true,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        expect(liveBareSenderRef.current).not.toBeNull()
      }).pipe(Effect.scoped)
    )
    expect(liveBareSenderRef.current).toBeNull()
  })
})

describe('BridgeTransport.setLayers — atomic handler swap', () => {
  test('replaces per-tag handlers on the next inbound message without rebuilding the transport', async () => {
    // Cold-start regression guard: before `setLayers`, a fresh receiver
    // layer on the host required `BridgeTransport.make` to re-run from
    // scratch (queue, dispatch fiber, peerReady — all torn down and
    // recreated). The BridgedWebView consumer relied on that, which
    // tore the WebView down with it and flashed the loader. `setLayers`
    // swaps the handler map in place via the internal `Ref`; the
    // queue, dispatch fiber, schemas, and outbound senders all persist.
    const { NavigationLike } = makeBridges()
    const seen: Array<{ via: 'first' | 'second'; value: number }> = []
    const firstLayer = NavigationLike.Web.ReceiverLayer({
      Ping: ({ value }) => Effect.sync(() => seen.push({ via: 'first', value })),
    })
    const secondLayer = NavigationLike.Web.ReceiverLayer({
      Ping: ({ value }) => Effect.sync(() => seen.push({ via: 'second', value })),
    })
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [firstLayer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))

        yield* transport.enqueue(Schema.encodeSync(Ping)({ _tag: 'Ping', value: 1 }))
        yield* transport.flushed
        yield* transport.setLayers([secondLayer] as const)
        yield* transport.enqueue(Schema.encodeSync(Ping)({ _tag: 'Ping', value: 2 }))
        yield* transport.flushed

        expect(seen).toEqual([
          { via: 'first', value: 1 },
          { via: 'second', value: 2 },
        ])
      }).pipe(Effect.scoped)
    )
  })

  test('preserves the `peerReady` Deferred across swaps (host sends remain gated by the original `__Ready`)', async () => {
    // The `peerReady` Deferred is captured once at make time; setLayers
    // must not rebuild it or a host that already received `__Ready`
    // would suddenly start gating again on a fresh deferred.
    const { NavigationLike } = makeBridges()
    const firstLayer = NavigationLike.Host.ReceiverLayer({
      Pong: () => Effect.void,
    })
    const secondLayer = NavigationLike.Host.ReceiverLayer({
      Pong: () => Effect.void,
    })
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [firstLayer] as const,
          side: 'Host',
        }).pipe(Effect.provide(adapterLayer))

        // Resolve `peerReady` via the inbound __Ready handler.
        yield* transport.enqueue('{"_tag":"__Ready"}')
        yield* transport.flushed

        yield* transport.setLayers([secondLayer] as const)
        yield* transport.sendMessage({ _tag: 'Ping', value: 5 })

        // If setLayers had rebuilt peerReady, this send would have
        // suspended forever; reaching the assertion proves the
        // deferred persisted across the swap.
        expect(sentSink).toHaveLength(1)
        expect(JSON.parse(sentSink[0] ?? '')).toMatchObject({ _tag: 'Ping', value: 5 })
      }).pipe(Effect.scoped)
    )
  })

  test('rapid back-to-back setLayers calls converge on the last layer (no race, no leak)', async () => {
    // Property guard for the BridgedWebView consumer that drops the
    // useEffect cleanup `Fiber.interrupt(setLayersFiber)`: with the
    // interrupt removed, every forked discharge runs to completion. If
    // the runtime ordered Ref.set differently from fork order — or if
    // one of the intermediate discharges leaked a partial handler map —
    // the final dispatch would land on an earlier layer's id rather
    // than the last.
    //
    // Drives a sequence of N layers each tagged with its position; after
    // installing them sequentially via `setLayers`, dispatches one Ping
    // and asserts only the last layer's handler ran.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (n) => {
        const { NavigationLike } = makeBridges()
        const observed: number[] = []
        const buildLayerForIndex = (
          i: number
        ): ReturnType<typeof NavigationLike.Web.ReceiverLayer> =>
          NavigationLike.Web.ReceiverLayer({
            Ping: () => Effect.sync(() => observed.push(i)),
          })
        const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
        await Effect.runPromise(
          Effect.gen(function* () {
            const transport = yield* BridgeTransport.make({
              bridges: [NavigationLike] as const,
              layers: [buildLayerForIndex(0)] as const,
              side: 'Web',
            }).pipe(Effect.provide(adapterLayer))

            // Issue every setLayers call in sequence. Each completes
            // its `Ref.set(handlersRef, …)` before the next runs, so
            // the final ref state matches the last layer.
            for (let i = 1; i < n; i++) {
              yield* transport.setLayers([buildLayerForIndex(i)] as const)
            }

            yield* transport.enqueue(Schema.encodeSync(Ping)({ _tag: 'Ping', value: 1 }))
            yield* transport.flushed

            expect(observed).toEqual([n - 1])
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
    const seen: number[] = []
    const layer = NavigationLike.Web.ReceiverLayer({
      Ping: ({ value }) => Effect.sync(() => seen.push(value)),
    })
    const initialEncoded = Schema.encodeSync(Ping)({ _tag: 'Ping', value: 7 })
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make({
      initialMessages: [initialEncoded],
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        yield* transport.flushed
        expect(seen).toEqual([7])
      }).pipe(Effect.scoped)
    )
  })
})

describe('BridgeTransport.make — __Ready handshake', () => {
  test('Host sendMessage suspends until __Ready is enqueued, then flows', async () => {
    const { NavigationLike } = makeBridges()
    const layer = NavigationLike.Host.ReceiverLayer({ Pong: () => Effect.void })
    const {
      layer: adapterLayer,
      sentSink,
      liveBareSenderRef,
    } = TestPlatformAdapterLayer.make({
      captureBareSenderLive: true,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Host',
        }).pipe(Effect.provide(adapterLayer))
        // Pre-Ready: sendMessage suspends. Race with a short timeout to
        // confirm it doesn't complete until Ready arrives.
        const sendFiber = yield* Effect.fork(transport.sendMessage({ _tag: 'Ping', value: 1 }))
        yield* Effect.sleep(20)
        expect(sentSink).toHaveLength(0)
        // Post __Ready into the dispatch fiber.
        if (liveBareSenderRef.current === null) throw new Error('liveBareSenderRef not captured')
        yield* liveBareSenderRef.current('{"_tag":"__Ready"}')
        // Now the send completes.
        yield* sendFiber.await
        expect(sentSink).toHaveLength(1)
        expect(JSON.parse(sentSink[0] ?? '')).toEqual({ _tag: 'Ping', value: 1 })
      }).pipe(Effect.scoped)
    )
  })

  test('Web sendMessage flows immediately without a Ready', async () => {
    const { NavigationLike } = makeBridges()
    const layer = NavigationLike.Web.ReceiverLayer({
      Ping: () => Effect.void,
    })
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        yield* transport.sendMessage({ _tag: 'Pong', reply: 'hi' })
        expect(sentSink).toHaveLength(1)
        expect(JSON.parse(sentSink[0] ?? '')).toEqual({ _tag: 'Pong', reply: 'hi' })
      }).pipe(Effect.scoped)
    )
  })

  test('Web signalReady posts __Ready via bareSender', async () => {
    const { NavigationLike } = makeBridges()
    const layer = NavigationLike.Web.ReceiverLayer({ Ping: () => Effect.void })
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        yield* transport.signalReady
        expect(sentSink).toEqual(['{"_tag":"__Ready"}'])
      }).pipe(Effect.scoped)
    )
  })

  test('Host signalReady is a no-op', async () => {
    const { NavigationLike } = makeBridges()
    const layer = NavigationLike.Host.ReceiverLayer({ Pong: () => Effect.void })
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
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
    const layer = NavigationLike.Web.ReceiverLayer({ Ping: () => Effect.void })
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { maxLength: 20 }),
        async (lateMessages: ReadonlyArray<string>) => {
          const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
          let capturedEnqueue: ((raw: string) => Effect.Effect<void>) | null = null
          await Effect.runPromise(
            Effect.gen(function* () {
              const transport = yield* BridgeTransport.make({
                bridges: [NavigationLike] as const,
                layers: [layer] as const,
                side: 'Web',
              }).pipe(Effect.provide(adapterLayer))
              capturedEnqueue = transport.enqueue
            }).pipe(Effect.scoped)
          )
          if (capturedEnqueue === null) throw new Error('enqueue not captured')
          for (const msg of lateMessages) {
            ;(capturedEnqueue as (raw: string) => void)(msg)
          }
        }
      ),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })
})
