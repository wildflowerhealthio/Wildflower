import type { Context } from 'effect'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import { defineBridge } from '../src/define-bridge.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))
const Buzz = Schema.parseJson(Schema.TaggedStruct('Buzz', {}))

const NoOptions = Schema.Struct({})

// The return type is the long generic `BridgeDefinition<...>` produced
// by `defineBridge`; using `ReturnType<typeof defineBridge<...>>` would
// require restating all five generic arguments. Inferred-return is the
// pragmatic choice here.
// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
const makeTestBridge = (name: string = 'Test') =>
  defineBridge({
    name,
    nativeToWeb: [
      ['Ping', Ping],
      ['Buzz', Buzz],
    ] as const,
    webToNative: [['Pong', Pong]] as const,
    nativeOptionsShape: Schema.Struct({ greeting: Schema.String }),
    webOptionsShape: NoOptions,
  })

describe('defineBridge — shape', () => {
  test('exposes both halves with the correct outbound/inbound mapping', () => {
    const bridge = makeTestBridge()

    expect(Object.keys(bridge.Native.OutboundSchemas).toSorted()).toEqual(['Buzz', 'Ping'])
    expect(Object.keys(bridge.Native.InboundSchemas)).toEqual(['Pong'])
    expect(Object.keys(bridge.Web.OutboundSchemas)).toEqual(['Pong'])
    expect(Object.keys(bridge.Web.InboundSchemas).toSorted()).toEqual(['Buzz', 'Ping'])
  })

  test('preserves schema identities across the OutboundSchemas record', () => {
    const bridge = makeTestBridge()
    expect(bridge.Native.OutboundSchemas.Ping).toBe(Ping)
    expect(bridge.Native.OutboundSchemas.Buzz).toBe(Buzz)
    expect(bridge.Web.OutboundSchemas.Pong).toBe(Pong)
  })

  test('OptionsShape is the literal schema passed in', () => {
    const NativeOpts = Schema.Struct({ greeting: Schema.String })
    const bridge = defineBridge({
      name: 'OptsTest',
      nativeToWeb: [] as const,
      webToNative: [] as const,
      nativeOptionsShape: NativeOpts,
      webOptionsShape: NoOptions,
    })
    expect(bridge.Native.OptionsShape).toBe(NativeOpts)
    expect(bridge.Web.OptionsShape).toBe(NoOptions)
  })

  test('options round-trip through their declared shape', () => {
    const bridge = makeTestBridge()
    const decoded = Schema.decodeUnknownSync(bridge.Native.OptionsShape)({ greeting: 'hi' })
    expect(decoded).toEqual({ greeting: 'hi' })
  })

  test('handles empty pair lists on either side', () => {
    const bridge = defineBridge({
      name: 'Empty',
      nativeToWeb: [] as const,
      webToNative: [] as const,
      nativeOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    expect(Object.keys(bridge.Native.OutboundSchemas)).toEqual([])
    expect(Object.keys(bridge.Web.OutboundSchemas)).toEqual([])
  })
})

describe('defineBridge — HandlerTag', () => {
  test('mints a fresh runtime tag instance per call (even with the same name)', () => {
    const a = makeTestBridge('Same')
    const b = makeTestBridge('Same')
    expect(a.Native.HandlerTag).not.toBe(b.Native.HandlerTag)
    expect(a.Web.HandlerTag).not.toBe(b.Web.HandlerTag)
  })

  test('Native and Web halves of the same call have distinct tags', () => {
    const bridge = makeTestBridge()
    // Cross-side comparison only — same call, different sides.
    expect(bridge.Native.HandlerTag).not.toBe(
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      bridge.Web.HandlerTag as unknown as typeof bridge.Native.HandlerTag
    )
  })

  test('the tag.key reflects the bridge name and side', () => {
    const bridge = makeTestBridge('Inspect')
    expect(bridge.Native.HandlerTag.key).toBe('Inspect.Native.HandlerTag')
    expect(bridge.Web.HandlerTag.key).toBe('Inspect.Web.HandlerTag')
  })
})

describe('defineBridge — ReceiverLayer', () => {
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

describe('defineBridge — makeSender', () => {
  test('encodes the typed message via the matching outbound schema', () => {
    const bridge = makeTestBridge()
    const sent: string[] = []
    const sender = bridge.Native.makeSender((encoded) =>
      Effect.sync(() => {
        sent.push(encoded)
      })
    )

    Effect.runSync(sender({ _tag: 'Ping', value: 42 }))
    Effect.runSync(sender({ _tag: 'Buzz' }))

    expect(sent).toHaveLength(2)
    expect(JSON.parse(sent[0])).toEqual({ _tag: 'Ping', value: 42 })
    expect(JSON.parse(sent[1])).toEqual({ _tag: 'Buzz' })
  })

  test('round-trips a sent message through the inbound schema on the other side', () => {
    const bridge = makeTestBridge()
    const sent: string[] = []
    const sender = bridge.Native.makeSender((encoded) =>
      Effect.sync(() => {
        sent.push(encoded)
      })
    )

    Effect.runSync(sender({ _tag: 'Ping', value: 99 }))

    // The receiving side's InboundSchemas owns the matching schema.
    const decoded = Schema.decodeSync(bridge.Web.InboundSchemas.Ping)(sent[0])
    expect(decoded).toEqual({ _tag: 'Ping', value: 99 })
  })

  test('two bridges` Native senders compose via function intersection', () => {
    const navBridge = defineBridge({
      name: 'Nav',
      nativeToWeb: [['Buzz', Buzz]] as const,
      webToNative: [] as const,
      nativeOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    const gkBridge = defineBridge({
      name: 'Gk',
      nativeToWeb: [['Ping', Ping]] as const,
      webToNative: [] as const,
      nativeOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })

    const sent: string[] = []
    const navSender = navBridge.Native.makeSender((encoded) =>
      Effect.sync(() => {
        sent.push(encoded)
      })
    )
    const gkSender = gkBridge.Native.makeSender((encoded) =>
      Effect.sync(() => {
        sent.push(encoded)
      })
    )

    // The implementation takes the union of both senders' arguments — a
    // discriminated union TS narrows on `_tag`. The single cast to the
    // intersection type is unavoidable: TS does not synthesise overload-
    // intersections from a union-argument implementation. This is the
    // canonical "merge two senders" pattern aggregators will use.
    type NavMessage = Parameters<typeof navSender>[0]
    type GkMessage = Parameters<typeof gkSender>[0]
    const dispatchUnion = (message: NavMessage | GkMessage): Effect.Effect<void> => {
      if (message._tag === 'Buzz') return navSender(message)
      return gkSender(message)
    }
    const combined = dispatchUnion as typeof navSender & typeof gkSender

    Effect.runSync(combined({ _tag: 'Buzz' }))
    Effect.runSync(combined({ _tag: 'Ping', value: 1 }))

    expect(sent).toHaveLength(2)
    expect(JSON.parse(sent[0])).toEqual({ _tag: 'Buzz' })
    expect(JSON.parse(sent[1])).toEqual({ _tag: 'Ping', value: 1 })
  })
})

describe('defineBridge — ValidatedPairs', () => {
  test('compile-time: a schema whose decoded _tag does not match the declared tag is rejected', () => {
    // The next call passes `Ping` schema (decodes `_tag: 'Ping'`) under
    // the declared tag `'Pong'`. ValidatedPairs returns an error tuple
    // for that pair, breaking the input-shape match. Wrapped in
    // `// @ts-expect-error` to assert the error fires.
    const bridge = defineBridge({
      name: 'BadPair',
      nativeToWeb: [
        // @ts-expect-error — Ping schema does not encode/decode `_tag: 'Pong'`.
        ['Pong', Ping],
      ] as const,
      webToNative: [] as const,
      nativeOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    // The runtime still produces *something* — the type error doesn't
    // halt execution. The test exists for the compile-time signal; the
    // expression below just keeps the value referenced.
    expect(bridge.name).toBe('BadPair')
  })

  test('compile-time: a non-Schema value in position 1 is rejected', () => {
    const bridge = defineBridge({
      name: 'BadShape',
      nativeToWeb: [
        // @ts-expect-error — string is not a Schema with string-encoded JSON form.
        ['Whatever', 'not-a-schema'],
      ] as const,
      webToNative: [] as const,
      nativeOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    expect(bridge.name).toBe('BadShape')
  })

  test('compile-time: matching pairs typecheck cleanly', () => {
    // No `@ts-expect-error` — this block is the positive control: the
    // declared tag matches the schema's `_tag` literal.
    const bridge = defineBridge({
      name: 'GoodPair',
      nativeToWeb: [['Ping', Ping]] as const,
      webToNative: [['Pong', Pong]] as const,
      nativeOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    expect(bridge.Native.OutboundSchemas.Ping).toBe(Ping)
  })
})

describe('defineBridge — phantom types', () => {
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
    const _sendable: typeof bridge.Native.SendableMessageType = { _tag: 'Ping', value: 1 }
    const _sender: typeof bridge.Native.SenderType = (msg) =>
      Effect.sync(() => {
        expect(msg._tag).toMatch(/Ping|Buzz/)
      })
    const _options: typeof bridge.Native.OptionsType = { greeting: 'hello' }

    expect(_handlers.Ping).toBeTypeOf('function')
    expect(_sendable._tag).toBe('Ping')
    expect(_sender).toBeTypeOf('function')
    expect(_options.greeting).toBe('hello')
  })

  test('phantom *runtime* values are placeholders — never call them', () => {
    const bridge = makeTestBridge()
    // The HandlerType / SenderType etc. are runtime `undefined`; the
    // test only proves they exist as properties (the type carrier).
    expect(bridge.Native.HandlerType).toBeUndefined()
    expect(bridge.Native.SendableMessageType).toBeUndefined()
    expect(bridge.Native.SenderType).toBeUndefined()
    expect(bridge.Native.OptionsType).toBeUndefined()
  })
})

describe('defineBridge — Layer integration', () => {
  test('two bridges` ReceiverLayers compose into one merged context', () => {
    const a = defineBridge({
      name: 'A',
      nativeToWeb: [['Buzz', Buzz]] as const,
      webToNative: [] as const,
      nativeOptionsShape: NoOptions,
      webOptionsShape: NoOptions,
    })
    const b = defineBridge({
      name: 'B',
      nativeToWeb: [['Ping', Ping]] as const,
      webToNative: [] as const,
      nativeOptionsShape: NoOptions,
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

describe('defineBridge — internal types stay sealed', () => {
  test('OutboundSchemas is structurally a record (compile-only assertion)', () => {
    const bridge = makeTestBridge()
    // Indexing by a known key returns the precise schema type.
    const ping: typeof bridge.Native.OutboundSchemas.Ping = Ping
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
