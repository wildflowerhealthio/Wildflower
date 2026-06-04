import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { assertType, describe, expect, test } from 'vite-plus/test'
import * as Bridge from './bridge.ts'
import type * as MessageHandler from './message-handler.ts'
import * as Message from './message.ts'

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
  test('exposes the HostToWeb / WebToHost directional records', () => {
    const bridge = makeTestBridge()
    expect(bridge).toMatchObject({
      HostToWeb: { Ping, Buzz },
      WebToHost: { Pong },
    })
  })

  test('handles empty pair lists on either side', () => {
    const bridge = Bridge.make({
      name: 'Empty',
      hostToWeb: [] as const,
      webToHost: [] as const,
    })
    expect(Object.keys(bridge.HostToWeb)).toEqual([])
    expect(Object.keys(bridge.WebToHost)).toEqual([])
  })
})

describe('Bridge.make — encode', () => {
  test('encodes a typed host→web message via the matching outbound schema', () => {
    const bridge = makeTestBridge()

    expect(
      JSON.parse(
        Effect.runSync(Message.stringifyMessage(bridge.HostToWeb, { _tag: 'Ping', value: 42 }))
      )
    ).toEqual({
      _tag: 'Ping',
      value: 42,
    })
    expect(
      JSON.parse(Effect.runSync(Message.stringifyMessage(bridge.HostToWeb, { _tag: 'Buzz' })))
    ).toEqual({
      _tag: 'Buzz',
    })
  })

  test('round-trips an encoded host→web message through the web side’s inbound schema', () => {
    const bridge = makeTestBridge()
    // The web side's inbound record *is* the host→web record, so encoding
    // with `HostToWeb` and decoding with the same record models the wire
    // crossing host→web.
    const wire = Effect.runSync(
      Message.stringifyMessage(bridge.HostToWeb, { _tag: 'Ping', value: 99 })
    )
    const decoded = Schema.decodeSync(bridge.HostToWeb.Ping)(wire)
    expect(decoded).toEqual({ _tag: 'Ping', value: 99 })
  })
})

// These tests are type-only: each `@ts-expect-error` is what's actually
// being asserted (tsc fails compilation when the offending call wouldn't
// error). `Bridge.make` is permissive at runtime — it doesn't validate
// pairs — so a runtime `expect(bridge.name).toBe('BadPair')` would pass
// regardless of whether the type rejection fired, which is why the
// previous runtime assertions were tautological. Vitest's `expectTypeOf`
// tests type *relations* (e.g. `A extends B`), not "this call should be
// a type error," so the directives stay as the canonical assertion.
describe('Bridge.make — ValidatedPairs (type-only)', () => {
  test('a schema whose decoded _tag does not match the declared tag is rejected', () => {
    Bridge.make({
      name: 'BadPair',
      hostToWeb: [
        // @ts-expect-error — Ping schema does not encode/decode `_tag: 'Pong'`.
        ['Pong', Ping],
      ] as const,
      webToHost: [] as const,
    })
  })

  test('a non-Schema value in position 1 is rejected', () => {
    Bridge.make({
      name: 'BadShape',
      hostToWeb: [
        // @ts-expect-error — string is not a Schema with string-encoded JSON form.
        ['Whatever', 'not-a-schema'],
      ] as const,
      webToHost: [] as const,
    })
  })

  test('matching pairs typecheck cleanly', () => {
    const bridge = Bridge.make({
      name: 'GoodPair',
      hostToWeb: [['Ping', Ping]] as const,
      webToHost: [['Pong', Pong]] as const,
    })
    // Non-tautological: the keyed access only typechecks when the
    // schema pair shapes are accepted by `Bridge.make`'s positional
    // validation, and the runtime identity guards against silent rewires.
    expect(bridge.HostToWeb.Ping).toBe(Ping)
  })
})

describe('Bridge.make — type-level surface', () => {
  test('compile-only: derived types match indexed schema accesses', () => {
    const bridge = makeTestBridge()
    // The web side receives the host→web record.
    type Inbound = (typeof bridge.HostToWeb)['Ping']
    type InboundType = Schema.Schema.Type<Inbound>
    assertType<InboundType>({ _tag: 'Ping', value: 1 })

    // The web side consumes `HandlersFor` over the bridge's `HostToWeb`
    // record (its inbound direction) — the shape `makeWebTransport` and
    // `registerHandlers` consume.
    type WebHandlers = MessageHandler.HandlersFor<(typeof bridge)['HostToWeb']>
    assertType<WebHandlers>({
      Ping: ({ value }) => Effect.sync(() => expect(typeof value).toBe('number')),
      Buzz: () => Effect.void,
    })

    // `SendableMessage<[B], 'HostToWeb'>` is the decoded union the host may
    // send (the bridge's host→web tags).
    type HostOutbound = Bridge.SendableMessage<readonly [typeof bridge], 'HostToWeb'>
    assertType<HostOutbound>({ _tag: 'Ping', value: 1 })
    assertType<HostOutbound>({ _tag: 'Buzz' })
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
        expect(Object.keys(bridge.HostToWeb).toSorted()).toEqual(hostOnly.toSorted())
        expect(Object.keys(bridge.WebToHost).toSorted()).toEqual(webTags.toSorted())
      }
    ),
    { numRuns: numRunsFor({ base: 100 }) }
  )
})

test('property: stringify → decodeSync round-trips identity for any wired message', () => {
  const bridge = makeTestBridge()
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer().map((value) => ({ _tag: 'Ping' as const, value })),
        fc.constant({ _tag: 'Buzz' as const })
      ),
      (message) => {
        const wire = Effect.runSync(Message.stringifyMessage(bridge.HostToWeb, message))
        const decoded: unknown =
          message._tag === 'Ping'
            ? Schema.decodeSync(bridge.HostToWeb.Ping)(wire)
            : Schema.decodeSync(bridge.HostToWeb.Buzz)(wire)
        expect(decoded).toEqual(message)
      }
    ),
    { numRuns: numRunsFor({ base: 100 }) }
  )
})
