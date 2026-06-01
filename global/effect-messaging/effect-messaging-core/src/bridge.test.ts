import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { assertType, describe, expect, test } from 'vite-plus/test'
import * as Bridge from './bridge.ts'
import * as TestPlatformAdapterLayer from './test-platform-adapter-layer.ts'

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

    // The inbound-handler record type is `HalfHandlers` keyed by the
    // half's `InboundSchemas` — the shape `BridgeTransport.make` and
    // `registerHandlers` consume.
    type WebHandlers = Bridge.HalfHandlers<typeof bridge.Web>
    assertType<WebHandlers>({
      Ping: ({ value }) => Effect.sync(() => expect(typeof value).toBe('number')),
      Buzz: () => Effect.void,
    })

    type HostSender = typeof bridge.Host.send
    assertType<Parameters<HostSender>[0]>({ _tag: 'Ping', value: 1 })
    assertType<Parameters<HostSender>[0]>({ _tag: 'Buzz' })
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
    { numRuns: numRunsFor({ base: 100 }) }
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
    { numRuns: numRunsFor({ base: 100 }) }
  )
})
