import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import * as BridgeTransport from '../src/bridge-transport.ts'
import * as Bridge from '../src/bridge.ts'
import * as TestPlatformAdapterLayer from '../src/test-platform-adapter-layer.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))
const NoOptions = Schema.Struct({})

// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
const makeBridges = () => {
  const NavigationLike = Bridge.make({
    name: 'NavLike',
    hostToWeb: [['Ping', Ping]] as const,
    webToHost: [['Pong', Pong]] as const,
    hostOptionsShape: NoOptions,
    webOptionsShape: NoOptions,
  })
  return { NavigationLike }
}

describe('BridgeTransport.make — duplicate outbound-tag throw', () => {
  test('two bridges declaring the same outbound tag fail synchronously', async () => {
    const A = Bridge.make({
      name: 'A',
      hostToWeb: [['Ping', Ping]] as const,
      webToHost: [] as const,
      hostOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    const B = Bridge.make({
      name: 'B',
      hostToWeb: [['Ping', Ping]] as const,
      webToHost: [] as const,
      hostOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
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
        transport.enqueue(Schema.encodeSync(Ping)({ _tag: 'Ping', value: 1 }))
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
  test('attachLive callback receives enqueue and routes through the dispatch fiber', async () => {
    const { NavigationLike } = makeBridges()
    let pingCalls = 0
    const layer = NavigationLike.Web.ReceiverLayer({
      Ping: () => Effect.sync(() => (pingCalls += 1)),
    })
    const { layer: adapterLayer, liveEnqueueRef } = TestPlatformAdapterLayer.make({
      captureAttachLive: true,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        if (liveEnqueueRef.current === null) throw new Error('liveEnqueueRef not captured')
        liveEnqueueRef.current(Schema.encodeSync(Ping)({ _tag: 'Ping', value: 99 }))
        yield* transport.flushed
        expect(pingCalls).toBe(1)
      }).pipe(Effect.scoped)
    )
  })

  test('scope close detaches the live enqueue', async () => {
    const { NavigationLike } = makeBridges()
    const layer = NavigationLike.Web.ReceiverLayer({ Ping: () => Effect.void })
    const { layer: adapterLayer, liveEnqueueRef } = TestPlatformAdapterLayer.make({
      captureAttachLive: true,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        expect(liveEnqueueRef.current).not.toBeNull()
      }).pipe(Effect.scoped)
    )
    expect(liveEnqueueRef.current).toBeNull()
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

describe('BridgeTransport.make — queue lifecycle', () => {
  test('property: late enqueues after scope close drop without throwing', async () => {
    const { NavigationLike } = makeBridges()
    const layer = NavigationLike.Web.ReceiverLayer({ Ping: () => Effect.void })
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { maxLength: 20 }),
        async (lateMessages: ReadonlyArray<string>) => {
          const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
          let capturedEnqueue: ((raw: string) => void) | null = null
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
      { numRuns: 25 }
    )
  })
})
