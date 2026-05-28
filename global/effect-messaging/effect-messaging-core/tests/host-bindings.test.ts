import { Effect, Layer, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'
import type * as BridgeTransport from '../src/bridge-transport.ts'
import * as Bridge from '../src/bridge.ts'
import * as HostBindings from '../src/host-bindings.ts'

// ---------------------------------------------------------------------------
// Fixture bridges — distinct names so identity equality survives the
// parallel-array concatenation in `combine`.
// ---------------------------------------------------------------------------

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))

const AlphaBridge = Bridge.make({
  name: 'Alpha',
  hostToWeb: [['Ping', Ping]] as const,
  webToHost: [['Pong', Pong]] as const,
})

const BetaBridge = Bridge.make({
  name: 'Beta',
  hostToWeb: [['Ping', Ping]] as const,
  webToHost: [] as const,
})

const GammaBridge = Bridge.make({
  name: 'Gamma',
  hostToWeb: [] as const,
  webToHost: [['Pong', Pong]] as const,
})

// Sentinel layers — `Layer.effectDiscard(Effect.void)` is enough to
// satisfy the receiver-layer slot at the type level; the production
// helpers only flat-concat receiver layers, they don't build the
// context from them.
const AlphaReceiverLayer = AlphaBridge.Host.ReceiverLayer({
  Pong: () => Effect.void,
})
const BetaReceiverLayer = BetaBridge.Host.ReceiverLayer({})
const GammaReceiverLayer = GammaBridge.Host.ReceiverLayer({
  Pong: () => Effect.void,
})

// ---------------------------------------------------------------------------
// single
// ---------------------------------------------------------------------------

describe('HostBindings.single', () => {
  test('produces 1-tuples in every slot with the supplied values', () => {
    const onReady = (
      _send: BridgeTransport.MessageSender<readonly [typeof AlphaBridge], 'Host'>
    ): Effect.Effect<void> => Effect.void

    const bindings = HostBindings.single({
      bridge: AlphaBridge,
      receiverLayer: AlphaReceiverLayer,
      initialMessages: [{ _tag: 'Ping', value: 1 }],
      onTransportReady: onReady,
    })

    expect(bindings.bridges).toEqual([AlphaBridge])
    // Identity is what `BridgeTransport.make` consumes — assert it, not
    // just shape equality, so a future copy-on-write of the input would
    // surface here.
    expect(bindings.bridges[0]).toBe(AlphaBridge)
    expect(bindings.receiverLayers[0]).toBe(AlphaReceiverLayer)
    expect(bindings.initialMessages).toEqual([[{ _tag: 'Ping', value: 1 }]])
    expect(bindings.onTransportReady[0]).toBe(onReady)
  })

  test('defaults initialMessages to [[]] when omitted (1-tuple of empty inner array)', () => {
    const bindings = HostBindings.single({
      bridge: BetaBridge,
      receiverLayer: BetaReceiverLayer,
    })
    expect(bindings.initialMessages).toEqual([[]])
    expect(bindings.initialMessages).toHaveLength(1)
  })

  test('defaults onTransportReady to [undefined] when omitted', () => {
    const bindings = HostBindings.single({
      bridge: BetaBridge,
      receiverLayer: BetaReceiverLayer,
    })
    expect(bindings.onTransportReady).toEqual([undefined])
  })
})

// ---------------------------------------------------------------------------
// combine
// ---------------------------------------------------------------------------

describe('HostBindings.combine', () => {
  const alpha = HostBindings.single({
    bridge: AlphaBridge,
    receiverLayer: AlphaReceiverLayer,
    initialMessages: [{ _tag: 'Ping', value: 1 }],
  })
  const beta = HostBindings.single({
    bridge: BetaBridge,
    receiverLayer: BetaReceiverLayer,
    initialMessages: [
      { _tag: 'Ping', value: 2 },
      { _tag: 'Ping', value: 3 },
    ],
  })
  const gamma = HostBindings.single({
    bridge: GammaBridge,
    receiverLayer: GammaReceiverLayer,
    onTransportReady: () => Effect.void,
  })

  test('bridges concatenates in input order, preserving identity', () => {
    const merged = HostBindings.combine([alpha, beta, gamma])
    expect(merged.bridges).toEqual([AlphaBridge, BetaBridge, GammaBridge])
    // The flatten must reuse the same Bridge instances, not copies —
    // `BridgeTransport.make`'s context wiring keys on identity.
    expect(merged.bridges[0]).toBe(AlphaBridge)
    expect(merged.bridges[1]).toBe(BetaBridge)
    expect(merged.bridges[2]).toBe(GammaBridge)
  })

  test('receiverLayers concatenates index-aligned with bridges', () => {
    const merged = HostBindings.combine([alpha, beta, gamma])
    expect(merged.receiverLayers[0]).toBe(AlphaReceiverLayer)
    expect(merged.receiverLayers[1]).toBe(BetaReceiverLayer)
    expect(merged.receiverLayers[2]).toBe(GammaReceiverLayer)
  })

  test('initialMessages preserves the parallel-array shape (inner arrays are the per-bridge messages)', () => {
    const merged = HostBindings.combine([alpha, beta, gamma])
    expect(merged.initialMessages).toEqual([
      [{ _tag: 'Ping', value: 1 }],
      [
        { _tag: 'Ping', value: 2 },
        { _tag: 'Ping', value: 3 },
      ],
      [],
    ])
  })

  test('onTransportReady concatenates index-aligned, preserving undefined slots', () => {
    const merged = HostBindings.combine([alpha, beta, gamma])
    expect(merged.onTransportReady).toHaveLength(3)
    expect(merged.onTransportReady[0]).toBeUndefined()
    expect(merged.onTransportReady[1]).toBeUndefined()
    expect(merged.onTransportReady[2]).toBe(gamma.onTransportReady[0])
  })

  test('empty input produces an empty bindings struct', () => {
    const merged = HostBindings.combine([])
    expect(merged.bridges).toEqual([])
    expect(merged.receiverLayers).toEqual([])
    expect(merged.initialMessages).toEqual([])
    expect(merged.onTransportReady).toEqual([])
  })

  // Property: `combine([combine([a, b]), c])` deep-equals `combine([a, b, c])`
  // across all four arrays. Guards the flat-concat invariant against any
  // future short-circuiting in `flattenTuples` or its callers.
  test('associativity: combine is flat-concat-equivalent regardless of grouping', () => {
    fc.assert(
      fc.property(
        // Per-slot fixtures — keep the shapes light; the assertion is
        // structural, not semantic.
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 0, maxLength: 3 }),
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 0, maxLength: 3 }),
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 0, maxLength: 3 }),
        (aMsgs, bMsgs, cMsgs) => {
          const a = HostBindings.single({
            bridge: AlphaBridge,
            receiverLayer: AlphaReceiverLayer,
            initialMessages: aMsgs.map((value) => ({ _tag: 'Ping' as const, value })),
          })
          const b = HostBindings.single({
            bridge: BetaBridge,
            receiverLayer: BetaReceiverLayer,
            initialMessages: bMsgs.map((value) => ({ _tag: 'Ping' as const, value })),
          })
          const c = HostBindings.single({
            bridge: GammaBridge,
            receiverLayer: GammaReceiverLayer,
            initialMessages: [],
          })
          // `c` is bridge-of-no-host-to-web messages so a Ping payload
          // doesn't typecheck; the structural array shape still survives.
          void cMsgs

          const leftGrouped = HostBindings.combine([HostBindings.combine([a, b]), c])
          const rightGrouped = HostBindings.combine([HostBindings.combine([a]), b, c])
          const flat = HostBindings.combine([a, b, c])

          expect(leftGrouped.bridges).toEqual(flat.bridges)
          expect(leftGrouped.receiverLayers).toEqual(flat.receiverLayers)
          expect(leftGrouped.initialMessages).toEqual(flat.initialMessages)
          expect(leftGrouped.onTransportReady).toEqual(flat.onTransportReady)

          expect(rightGrouped.bridges).toEqual(flat.bridges)
          expect(rightGrouped.receiverLayers).toEqual(flat.receiverLayers)
          expect(rightGrouped.initialMessages).toEqual(flat.initialMessages)
          expect(rightGrouped.onTransportReady).toEqual(flat.onTransportReady)
        }
      ),
      { numRuns: 40 }
    )
  })
})

// ---------------------------------------------------------------------------
// callTransportReady
// ---------------------------------------------------------------------------

describe('HostBindings.callTransportReady', () => {
  // A no-op sender — `callTransportReady` only forwards the sender to
  // each slot's callback; for these tests we don't exercise the sender
  // itself, only the dispatch behaviour.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const noopSender = ((): Effect.Effect<void> =>
    Effect.void) as unknown as BridgeTransport.MessageSender<
    readonly [typeof AlphaBridge, typeof BetaBridge, typeof GammaBridge],
    'Host'
  >

  test('skips slots whose callback is undefined and invokes the rest exactly once', async () => {
    const calls: string[] = []
    const bindings = HostBindings.combine([
      HostBindings.single({
        bridge: AlphaBridge,
        receiverLayer: AlphaReceiverLayer,
        onTransportReady: () => Effect.sync(() => calls.push('alpha')),
      }),
      HostBindings.single({
        bridge: BetaBridge,
        receiverLayer: BetaReceiverLayer,
        // intentional: no onTransportReady
      }),
      HostBindings.single({
        bridge: GammaBridge,
        receiverLayer: GammaReceiverLayer,
        onTransportReady: () => Effect.sync(() => calls.push('gamma')),
      }),
    ])

    await Effect.runPromise(HostBindings.callTransportReady(bindings, noopSender))

    // Concurrency is unbounded; assert membership rather than order.
    expect(calls.toSorted()).toEqual(['alpha', 'gamma'])
  })

  test('a failing callback does not block sibling callbacks (fault isolation)', async () => {
    const calls: string[] = []
    const bindings = HostBindings.combine([
      HostBindings.single({
        bridge: AlphaBridge,
        receiverLayer: AlphaReceiverLayer,
        onTransportReady: () =>
          Effect.sync(() => calls.push('alpha-pre')).pipe(Effect.zipRight(Effect.die('boom'))),
      }),
      HostBindings.single({
        bridge: GammaBridge,
        receiverLayer: GammaReceiverLayer,
        onTransportReady: () => Effect.sync(() => calls.push('gamma')),
      }),
    ])

    // The Effect resolves successfully even though Alpha's callback dies —
    // `catchAllCause`/`logError` inside `callTransportReady` swallows the
    // failure into a log line.
    await Effect.runPromise(HostBindings.callTransportReady(bindings, noopSender))

    // Alpha's body ran up to the failure; Gamma ran cleanly. The key
    // assertion is that Gamma was not blocked by Alpha's defect.
    expect(calls).toContain('alpha-pre')
    expect(calls).toContain('gamma')
  })

  test('returns immediately when every slot is undefined', async () => {
    const bindings = HostBindings.combine([
      HostBindings.single({ bridge: AlphaBridge, receiverLayer: AlphaReceiverLayer }),
      HostBindings.single({ bridge: BetaBridge, receiverLayer: BetaReceiverLayer }),
    ])
    // Smoke test: this should resolve without throwing — there's nothing
    // observable beyond "no failure" since every slot is a no-op.
    await Expect.toResolve(Effect.runPromise(HostBindings.callTransportReady(bindings, noopSender)))
  })
})

// `expect` doesn't have a `toResolve` helper — the smoke test above
// uses this local alias so the intent reads clearly at the call site.
const Expect = {
  toResolve: async (p: Promise<unknown>): Promise<void> => {
    await p
  },
}
// Silence unused warning when the test runner picks this module up
// without exercising the smoke path.
void Layer
