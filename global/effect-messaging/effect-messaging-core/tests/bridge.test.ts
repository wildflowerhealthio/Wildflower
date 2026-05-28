import type { Context } from 'effect'
import { Effect, Layer, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { assertType, describe, expect, test } from 'vite-plus/test'
import * as Bridge from '../src/bridge.ts'
import * as TestPlatformAdapterLayer from '../src/test-platform-adapter-layer.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))
const Buzz = Schema.parseJson(Schema.TaggedStruct('Buzz', {}))

// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
const makeTestBridge = (name: string = 'Test') =>
  Bridge.make({
    name,
    hostToWeb: [
      ['Ping', Ping],
      ['Buzz', Buzz],
    ] as const,
    webToHost: [['Pong', Pong]] as const,
  })

describe('Bridge.make — shape', () => {
  test('exposes both halves with the correct outbound/inbound mapping', () => {
    const bridge = makeTestBridge()
    expect(bridge).toMatchObject({
      Host: { OutboundSchemas: { Ping, Buzz }, InboundSchemas: { Pong } },
      Web: { OutboundSchemas: { Pong }, InboundSchemas: { Ping, Buzz } },
    })
  })

  test('handles empty pair lists on either side', () => {
    const bridge = Bridge.make({
      name: 'Empty',
      hostToWeb: [] as const,
      webToHost: [] as const,
    })
    expect(Object.keys(bridge.Host.OutboundSchemas)).toEqual([])
    expect(Object.keys(bridge.Web.OutboundSchemas)).toEqual([])
  })
})

describe('Bridge.make — HandlerTag', () => {
  test('mints a fresh runtime tag instance per call (even with the same name)', () => {
    const a = makeTestBridge('Same')
    const b = makeTestBridge('Same')
    expect(a.Host.HandlerTag).not.toBe(b.Host.HandlerTag)
    expect(a.Web.HandlerTag).not.toBe(b.Web.HandlerTag)
  })

  test('Host and Web halves of the same call have distinct tags', () => {
    const bridge = makeTestBridge()
    expect(bridge.Host.HandlerTag).not.toBe(
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      bridge.Web.HandlerTag as unknown as typeof bridge.Host.HandlerTag
    )
  })

  test('the tag.key reflects the bridge name and side', () => {
    const bridge = makeTestBridge('Inspect')
    expect(bridge.Host.HandlerTag.key).toBe('Inspect.Host.HandlerTag')
    expect(bridge.Web.HandlerTag.key).toBe('Inspect.Web.HandlerTag')
  })
})

describe('Bridge.make — ReceiverLayer', () => {
  test('produces a Layer that supplies HandlerTag with the caller-provided handlers', () => {
    const bridge = makeTestBridge()
    const seen: number[] = []
    const layer = bridge.Web.ReceiverLayer({
      Ping: ({ value }) => Effect.sync(() => seen.push(value)),
      Buzz: () => Effect.sync(() => seen.push(-1)),
    })

    const program = Effect.gen(function* () {
      const handlers = yield* bridge.Web.HandlerTag
      yield* handlers.Ping({ _tag: 'Ping', value: 7 })
      yield* handlers.Buzz({ _tag: 'Buzz' })
    })
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

    Effect.runSync(Effect.provide(program, Layer.mergeAll(layer, adapterLayer)))
    expect(seen).toEqual([7, -1])
  })

  test('handlers from one bridge cannot satisfy a different bridge`s tag', () => {
    const a = makeTestBridge('A')
    const b = makeTestBridge('B')
    const aLayer = a.Web.ReceiverLayer({
      Ping: () => Effect.void,
      Buzz: () => Effect.void,
    })
    const program = Effect.gen(function* () {
      const handlers = yield* b.Web.HandlerTag
      return handlers
    })
    expect(() => Effect.runSync(Effect.provide(program, aLayer))).toThrow()
  })
})

describe('Bridge.make — send', () => {
  test('encodes the typed message via the matching outbound schema', () => {
    const bridge = makeTestBridge()
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make()

    Effect.runSync(bridge.Host.send({ _tag: 'Ping', value: 42 }).pipe(Effect.provide(adapterLayer)))
    Effect.runSync(bridge.Host.send({ _tag: 'Buzz' }).pipe(Effect.provide(adapterLayer)))

    expect(sentSink).toHaveLength(2)
    expect(JSON.parse(sentSink[0])).toEqual({ _tag: 'Ping', value: 42 })
    expect(JSON.parse(sentSink[1])).toEqual({ _tag: 'Buzz' })
  })

  test('round-trips a sent message through the inbound schema on the other side', () => {
    const bridge = makeTestBridge()
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make()
    Effect.runSync(bridge.Host.send({ _tag: 'Ping', value: 99 }).pipe(Effect.provide(adapterLayer)))
    const decoded = Schema.decodeSync(bridge.Web.InboundSchemas.Ping)(sentSink[0])
    expect(decoded).toEqual({ _tag: 'Ping', value: 99 })
  })

  test('two bridges` Host senders compose via the same adapter layer', () => {
    const navBridge = Bridge.make({
      name: 'Nav',
      hostToWeb: [['Buzz', Buzz]] as const,
      webToHost: [] as const,
    })
    const gkBridge = Bridge.make({
      name: 'Gk',
      hostToWeb: [['Ping', Ping]] as const,
      webToHost: [] as const,
    })

    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make()

    Effect.runSync(navBridge.Host.send({ _tag: 'Buzz' }).pipe(Effect.provide(adapterLayer)))
    Effect.runSync(
      gkBridge.Host.send({ _tag: 'Ping', value: 1 }).pipe(Effect.provide(adapterLayer))
    )

    expect(sentSink).toHaveLength(2)
    expect(JSON.parse(sentSink[0])).toEqual({ _tag: 'Buzz' })
    expect(JSON.parse(sentSink[1])).toEqual({ _tag: 'Ping', value: 1 })
  })
})

describe('Bridge.make — ValidatedPairs', () => {
  test('compile-time: a schema whose decoded _tag does not match the declared tag is rejected', () => {
    const bridge = Bridge.make({
      name: 'BadPair',
      hostToWeb: [
        // @ts-expect-error — Ping schema does not encode/decode `_tag: 'Pong'`.
        ['Pong', Ping],
      ] as const,
      webToHost: [] as const,
    })
    expect(bridge.name).toBe('BadPair')
  })

  test('compile-time: a non-Schema value in position 1 is rejected', () => {
    const bridge = Bridge.make({
      name: 'BadShape',
      hostToWeb: [
        // @ts-expect-error — string is not a Schema with string-encoded JSON form.
        ['Whatever', 'not-a-schema'],
      ] as const,
      webToHost: [] as const,
    })
    expect(bridge.name).toBe('BadShape')
  })

  test('compile-time: matching pairs typecheck cleanly', () => {
    const bridge = Bridge.make({
      name: 'GoodPair',
      hostToWeb: [['Ping', Ping]] as const,
      webToHost: [['Pong', Pong]] as const,
    })
    expect(bridge.Host.OutboundSchemas.Ping).toBe(Ping)
  })
})

describe('Bridge.make — type-level surface', () => {
  test('compile-only: derived types match indexed schema accesses', () => {
    const bridge = makeTestBridge()
    type Inbound = (typeof bridge.Web.InboundSchemas)['Ping']
    type InboundType = Schema.Schema.Type<Inbound>
    assertType<InboundType>({ _tag: 'Ping', value: 1 })

    type HandlerService = Context.Tag.Service<typeof bridge.Web.HandlerTag>
    assertType<HandlerService>({
      Ping: ({ value }) => Effect.sync(() => expect(typeof value).toBe('number')),
      Buzz: () => Effect.void,
    })

    type HostSender = typeof bridge.Host.send
    assertType<Parameters<HostSender>[0]>({ _tag: 'Ping', value: 1 })
    assertType<Parameters<HostSender>[0]>({ _tag: 'Buzz' })
  })
})

describe('Bridge.make — Layer integration', () => {
  test('two bridges` ReceiverLayers compose into one merged context', () => {
    const a = Bridge.make({
      name: 'A',
      hostToWeb: [['Buzz', Buzz]] as const,
      webToHost: [] as const,
    })
    const b = Bridge.make({
      name: 'B',
      hostToWeb: [['Ping', Ping]] as const,
      webToHost: [] as const,
    })

    const seen: string[] = []
    const aLayer = a.Web.ReceiverLayer({
      Buzz: () => Effect.sync(() => seen.push('Buzz')),
    })
    const bLayer = b.Web.ReceiverLayer({
      Ping: ({ value }) => Effect.sync(() => seen.push(`Ping(${value})`)),
    })

    const program = Effect.gen(function* () {
      const aHandlers = yield* a.Web.HandlerTag
      const bHandlers = yield* b.Web.HandlerTag
      yield* aHandlers.Buzz({ _tag: 'Buzz' })
      yield* bHandlers.Ping({ _tag: 'Ping', value: 11 })
    })
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

    Effect.runSync(Effect.provide(program, Layer.mergeAll(aLayer, bLayer, adapterLayer)))
    expect(seen).toEqual(['Buzz', 'Ping(11)'])
  })
})

// Pair arrays are cast through `never`: dynamic shape doesn't satisfy
// `ValidatedPairs`'s positional check, fine for pre-validated schemas.
test('property: outbound schema keys equal declared tag set', () => {
  const tagAlphabet = ['Ping', 'Pong', 'Buzz'] as const
  // oxlint-disable-next-line typescript-eslint/no-explicit-any
  const tagToSchema: Record<(typeof tagAlphabet)[number], any> = { Ping, Pong, Buzz }
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.constantFrom(...tagAlphabet), { minLength: 0, maxLength: 3 }),
      fc.uniqueArray(fc.constantFrom(...tagAlphabet), { minLength: 0, maxLength: 3 }),
      (hostTags, webTags) => {
        // Each side's outbound record is a disjoint set.
        const webTagSet = new Set(webTags)
        const hostOnly = hostTags.filter((t) => !webTagSet.has(t))
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const hostPairs = hostOnly.map((tag) => [tag, tagToSchema[tag]]) as never
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const webPairs = webTags.map((tag) => [tag, tagToSchema[tag]]) as never
        const bridge = Bridge.make({
          name: 'Prop',
          hostToWeb: hostPairs,
          webToHost: webPairs,
        })
        expect(Object.keys(bridge.Host.OutboundSchemas).toSorted()).toEqual(hostOnly.toSorted())
        expect(Object.keys(bridge.Web.OutboundSchemas).toSorted()).toEqual(webTags.toSorted())
      }
    ),
    { numRuns: numRunsFor(100) }
  )
})

test('property: send → decodeSync round-trips identity for any wired message', () => {
  const bridge = makeTestBridge()
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer().map((value) => ({ _tag: 'Ping' as const, value })),
        fc.constant({ _tag: 'Buzz' as const })
      ),
      (message) => {
        const { layer, sentSink } = TestPlatformAdapterLayer.make()
        Effect.runSync(bridge.Host.send(message).pipe(Effect.provide(layer)))
        expect(sentSink).toHaveLength(1)
        const decoded: unknown =
          message._tag === 'Ping'
            ? Schema.decodeSync(bridge.Web.InboundSchemas.Ping)(sentSink[0] ?? '')
            : Schema.decodeSync(bridge.Web.InboundSchemas.Buzz)(sentSink[0] ?? '')
        expect(decoded).toEqual(message)
      }
    ),
    { numRuns: numRunsFor(100) }
  )
})

test('property: same-name bridges always mint distinct HandlerTag instances', () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.boolean(),
      fc.boolean(),
      (name, includePing, includeBuzz) => {
        const aPairs = [
          ...(includePing ? [['Ping', Ping] as const] : []),
          ...(includeBuzz ? [['Buzz', Buzz] as const] : []),
        ]
        const bPairs = includeBuzz ? [['Buzz', Buzz] as const] : []
        const a = Bridge.make({
          name,
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          hostToWeb: aPairs as never,
          webToHost: [] as const,
        })
        const b = Bridge.make({
          name,
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          hostToWeb: bPairs as never,
          webToHost: [] as const,
        })
        expect(a.Host.HandlerTag).not.toBe(b.Host.HandlerTag)
        expect(a.Web.HandlerTag).not.toBe(b.Web.HandlerTag)
      }
    ),
    { numRuns: numRunsFor(100) }
  )
})
