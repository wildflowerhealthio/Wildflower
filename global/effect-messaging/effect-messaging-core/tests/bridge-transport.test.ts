import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import * as Bridge from '../src/bridge.ts'
import * as BridgeTransport from '../src/bridge-transport.ts'
import * as TestPlatformAdapterLayer from '../src/test-platform-adapter-layer.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))
const NoOptions = Schema.Struct({})

// Inferred return type — restating the generic `Bridge.Bridge<...>` is verbose.
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
    // Construct a handlers record whose `Ping` slot is `undefined` at
    // runtime — emulating a wiring drift the type system can't catch
    // (e.g. a future refactor partially populating a layer). The
    // `tagToBridgeIndex` resolves `Ping`, the schema decodes, but
    // `handlers[_tag]` is undefined → Internal error fires.
    const { NavigationLike } = makeBridges()
    // oxlint-disable-next-line typescript-eslint/no-explicit-any
    const handlers = { Ping: undefined as any }
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const layer = NavigationLike.Web.ReceiverLayer(handlers as never)
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
    const { promise, logSink } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        transport.enqueue(Schema.encodeSync(Ping)({ _tag: 'Ping', value: 1 }))
        yield* transport.flushed
      })
    )
    await promise
    const internal = logSink.find(
      (l) => l.level === 'WARN' && l.message.includes('internal dispatch invariant violated')
    )
    expect(internal).toBeDefined()
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
    const { promise } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        // The capture-stub stores `enqueue` in `liveEnqueueRef.current`.
        // Drive it as the platform's listener would.
        if (liveEnqueueRef.current === null) throw new Error('liveEnqueueRef not captured')
        liveEnqueueRef.current(Schema.encodeSync(Ping)({ _tag: 'Ping', value: 99 }))
        yield* transport.flushed
        expect(pingCalls).toBe(1)
      })
    )
    await promise
  })

  test('scope close detaches the live enqueue', async () => {
    const { NavigationLike } = makeBridges()
    const layer = NavigationLike.Web.ReceiverLayer({ Ping: () => Effect.void })
    const { layer: adapterLayer, liveEnqueueRef } = TestPlatformAdapterLayer.make({
      captureAttachLive: true,
    })
    const { promise } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        expect(liveEnqueueRef.current).not.toBeNull()
      })
    )
    await promise
    // After scope close, the acquireRelease finalizer ran and cleared the ref.
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
    const { promise } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationLike] as const,
          layers: [layer] as const,
          side: 'Web',
        }).pipe(Effect.provide(adapterLayer))
        yield* transport.flushed
        expect(seen).toEqual([7])
      })
    )
    await promise
  })
})

describe('BridgeTransport.make — queue lifecycle', () => {
  // Property: after scope close, `enqueue` calls drop cleanly — no
  // throw, no orphaned messages piling up. The shut-down queue rejects
  // offers; the Stream-from-queue with `shutdown: true` ensures the
  // fiber's release also shuts the queue.
  test('property: late enqueues after scope close drop without throwing', async () => {
    const { NavigationLike } = makeBridges()
    const layer = NavigationLike.Web.ReceiverLayer({ Ping: () => Effect.void })
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { maxLength: 20 }),
        async (lateMessages: ReadonlyArray<string>) => {
          const { layer: adapterLayer } = TestPlatformAdapterLayer.make()
          let capturedEnqueue: ((raw: string) => void) | null = null
          const { promise } = LoggingLayerTest.runScoped(
            Effect.gen(function* () {
              const transport = yield* BridgeTransport.make({
                bridges: [NavigationLike] as const,
                layers: [layer] as const,
                side: 'Web',
              }).pipe(Effect.provide(adapterLayer))
              capturedEnqueue = transport.enqueue
            })
          )
          await promise
          // After the scope has closed, fire the captured enqueue with
          // arbitrary inputs. A correct lifecycle drops cleanly.
          if (capturedEnqueue === null) throw new Error('enqueue not captured')
          for (const msg of lateMessages) {
            // oxlint-disable-next-line typescript-eslint/no-unsafe-call
            ;(capturedEnqueue as (raw: string) => void)(msg)
          }
        }
      ),
      { numRuns: 25 }
    )
  })
})
