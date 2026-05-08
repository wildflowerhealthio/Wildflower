import type { Context } from 'effect'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import * as Bridge from '../src/bridge.ts'
import * as TestPlatformAdapterLayer from '../src/test-platform-adapter-layer.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))
const Buzz = Schema.parseJson(Schema.TaggedStruct('Buzz', {}))

const NoOptions = Schema.Struct({})

// The return type is the long generic `BridgeDefinition<...>` produced
// by `Bridge.make`; using `ReturnType<typeof Bridge.make<...>>` would
// require restating all five generic arguments. Inferred-return is the
// pragmatic choice here.
// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
const makeTestBridge = (name: string = 'Test') =>
  Bridge.make({
    name,
    hostToWeb: [
      ['Ping', Ping],
      ['Buzz', Buzz],
    ] as const,
    webToHost: [['Pong', Pong]] as const,
    hostOptionsShape: Schema.Struct({ greeting: Schema.String }),
    webOptionsShape: NoOptions,
  })

describe('Bridge.make — shape', () => {
  test('exposes both halves with the correct outbound/inbound mapping', () => {
    const bridge = makeTestBridge()

    expect(Object.keys(bridge.Host.OutboundSchemas).toSorted()).toEqual(['Buzz', 'Ping'])
    expect(Object.keys(bridge.Host.InboundSchemas)).toEqual(['Pong'])
    expect(Object.keys(bridge.Web.OutboundSchemas)).toEqual(['Pong'])
    expect(Object.keys(bridge.Web.InboundSchemas).toSorted()).toEqual(['Buzz', 'Ping'])
  })

  test('preserves schema identities across the OutboundSchemas record', () => {
    const bridge = makeTestBridge()
    expect(bridge.Host.OutboundSchemas.Ping).toBe(Ping)
    expect(bridge.Host.OutboundSchemas.Buzz).toBe(Buzz)
    expect(bridge.Web.OutboundSchemas.Pong).toBe(Pong)
  })

  test('OptionsShape is the literal schema passed in', () => {
    const NativeOpts = Schema.Struct({ greeting: Schema.String })
    const bridge = Bridge.make({
      name: 'OptsTest',
      hostToWeb: [] as const,
      webToHost: [] as const,
      hostOptionsShape: NativeOpts,
      webOptionsShape: NoOptions,
    })
    expect(bridge.Host.OptionsShape).toBe(NativeOpts)
    expect(bridge.Web.OptionsShape).toBe(NoOptions)
  })

  test('options round-trip through their declared shape', () => {
    const bridge = makeTestBridge()
    const decoded = Schema.decodeUnknownSync(bridge.Host.OptionsShape)({ greeting: 'hi' })
    expect(decoded).toEqual({ greeting: 'hi' })
  })

  test('handles empty pair lists on either side', () => {
    const bridge = Bridge.make({
      name: 'Empty',
      hostToWeb: [] as const,
      webToHost: [] as const,
      hostOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
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
    // Cross-side comparison only — same call, different sides.
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

    // Resolve the handlers through the layer's Effect Context, mirroring
    // how the transport will look them up at dispatch time. Handlers are
    // Effect-typed; the test runs them via `yield*` inside the gen body.
    const program = Effect.gen(function* () {
      const handlers = yield* bridge.Web.HandlerTag
      yield* handlers.Ping({ _tag: 'Ping', value: 7 })
      yield* handlers.Buzz({ _tag: 'Buzz' })
    })

    Effect.runSync(Effect.provide(program, layer))
    expect(seen).toEqual([7, -1])
  })

  test('handlers from one bridge cannot satisfy a different bridge`s tag', () => {
    const a = makeTestBridge('A')
    const b = makeTestBridge('B')

    const aLayer = a.Web.ReceiverLayer({
      Ping: () => Effect.void,
      Buzz: () => Effect.void,
    })

    // Effect.provide for B's tag against A's layer should fail to
    // resolve at runtime: A's tag instance is not the same instance as
    // B's, so Context lookup misses. The type system also reports this
    // because the layer's identifier is `A.Web.HandlerTag`, not
    // `B.Web.HandlerTag`.
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
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make({})

    Effect.runSync(bridge.Host.send({ _tag: 'Ping', value: 42 }).pipe(Effect.provide(adapterLayer)))
    Effect.runSync(bridge.Host.send({ _tag: 'Buzz' }).pipe(Effect.provide(adapterLayer)))

    expect(sentSink).toHaveLength(2)
    expect(JSON.parse(sentSink[0])).toEqual({ _tag: 'Ping', value: 42 })
    expect(JSON.parse(sentSink[1])).toEqual({ _tag: 'Buzz' })
  })

  test('round-trips a sent message through the inbound schema on the other side', () => {
    const bridge = makeTestBridge()
    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make({})

    Effect.runSync(bridge.Host.send({ _tag: 'Ping', value: 99 }).pipe(Effect.provide(adapterLayer)))

    // The receiving side's InboundSchemas owns the matching schema.
    const decoded = Schema.decodeSync(bridge.Web.InboundSchemas.Ping)(sentSink[0])
    expect(decoded).toEqual({ _tag: 'Ping', value: 99 })
  })

  test('two bridges` Host senders compose via the same adapter layer', () => {
    const navBridge = Bridge.make({
      name: 'Nav',
      hostToWeb: [['Buzz', Buzz]] as const,
      webToHost: [] as const,
      hostOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    const gkBridge = Bridge.make({
      name: 'Gk',
      hostToWeb: [['Ping', Ping]] as const,
      webToHost: [] as const,
      hostOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })

    const { layer: adapterLayer, sentSink } = TestPlatformAdapterLayer.make({})

    // Each bridge owns its outbound vocabulary; both share one
    // {@link PlatformAdapter} layer, mirroring how aggregators (the
    // transport, the embedded SPA's main entrypoint) wire multiple
    // bridges through one byte sink.
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
    // The next call passes `Ping` schema (decodes `_tag: 'Ping'`) under
    // the declared tag `'Pong'`. ValidatedPairs returns an error tuple
    // for that pair, breaking the input-shape match. Wrapped in
    // `// @ts-expect-error` to assert the error fires.
    const bridge = Bridge.make({
      name: 'BadPair',
      hostToWeb: [
        // @ts-expect-error — Ping schema does not encode/decode `_tag: 'Pong'`.
        ['Pong', Ping],
      ] as const,
      webToHost: [] as const,
      hostOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    // The runtime still produces *something* — the type error doesn't
    // halt execution. The test exists for the compile-time signal; the
    // expression below just keeps the value referenced.
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
      hostOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    expect(bridge.name).toBe('BadShape')
  })

  test('compile-time: matching pairs typecheck cleanly', () => {
    // No `@ts-expect-error` — this block is the positive control: the
    // declared tag matches the schema's `_tag` literal.
    const bridge = Bridge.make({
      name: 'GoodPair',
      hostToWeb: [['Ping', Ping]] as const,
      webToHost: [['Pong', Pong]] as const,
      hostOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    expect(bridge.Host.OutboundSchemas.Ping).toBe(Ping)
  })
})

describe('Bridge.make — phantom types', () => {
  test('phantom-typed properties carry the expected TS types (compile-only)', () => {
    const bridge = makeTestBridge()
    // Each block typechecks the phantom type alias against a manually-
    // constructed value. No runtime assertion needed; if these
    // assignments fail TS, the test file won't compile.
    const _handlers: typeof bridge.Web.HandlerType = {
      Ping: ({ value }) =>
        Effect.sync(() => {
          expect(typeof value).toBe('number')
        }),
      Buzz: () => Effect.void,
    }
    const _sendable: typeof bridge.Host.SendableMessageType = { _tag: 'Ping', value: 1 }
    const _sender: typeof bridge.Host.SenderType = (msg) =>
      Effect.sync(() => {
        expect(msg._tag).toMatch(/Ping|Buzz/)
      })
    const _options: typeof bridge.Host.OptionsType = { greeting: 'hello' }

    expect(_handlers.Ping).toBeTypeOf('function')
    expect(_sendable._tag).toBe('Ping')
    expect(_sender).toBeTypeOf('function')
    expect(_options.greeting).toBe('hello')
  })

  test('phantom *runtime* values are placeholders — never call them', () => {
    const bridge = makeTestBridge()
    // The HandlerType / SenderType etc. are runtime `undefined`; the
    // test only proves they exist as properties (the type carrier).
    expect(bridge.Host.HandlerType).toBeUndefined()
    expect(bridge.Host.SendableMessageType).toBeUndefined()
    expect(bridge.Host.SenderType).toBeUndefined()
    expect(bridge.Host.OptionsType).toBeUndefined()
  })
})

describe('Bridge.make — Layer integration', () => {
  test('two bridges` ReceiverLayers compose into one merged context', () => {
    const a = Bridge.make({
      name: 'A',
      hostToWeb: [['Buzz', Buzz]] as const,
      webToHost: [] as const,
      hostOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    const b = Bridge.make({
      name: 'B',
      hostToWeb: [['Ping', Ping]] as const,
      webToHost: [] as const,
      hostOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
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

    Effect.runSync(Effect.provide(program, Layer.mergeAll(aLayer, bLayer)))
    expect(seen).toEqual(['Buzz', 'Ping(11)'])
  })
})

describe('Bridge.make — internal types stay sealed', () => {
  test('OutboundSchemas is structurally a record (compile-only assertion)', () => {
    const bridge = makeTestBridge()
    // Indexing by a known key returns the precise schema type.
    const ping: typeof bridge.Host.OutboundSchemas.Ping = Ping
    expect(ping).toBe(Ping)

    // Access through Context.Tag.Service<...> to assert the service
    // shape is `HandlersFor<Inbound>` as declared.
    type Service = Context.Tag.Service<typeof bridge.Web.HandlerTag>
    const _handlers: Service = {
      Ping: () => Effect.void,
      Buzz: () => Effect.void,
    }
    expect(_handlers.Ping).toBeTypeOf('function')
  })
})
