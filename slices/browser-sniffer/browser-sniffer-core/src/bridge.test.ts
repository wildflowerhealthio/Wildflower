import { Arbitrary, Deferred, Effect, Schema } from 'effect'
import { Bridge, BridgeTransport, type MessageHandler } from 'effect-messaging-core'
import * as TestPlatformAdapterLayer from 'effect-messaging-core/test'
import * as fc from 'fast-check'
import { LoggingLayerTest, numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import { BrowserSnifferBridge } from './bridge.ts'
import {
  PageRequestedMessage,
  CancelSnifferRequestMessage,
  CancelledMessage,
  PageActionMessage,
  PageLoadedMessage,
  RequestErrorMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  ResponseStartMessage,
} from './messages.ts'

type WebToHostMessage =
  | Schema.Schema.Type<typeof ResponseStartMessage>
  | Schema.Schema.Type<typeof ResponseDataMessage>
  | Schema.Schema.Type<typeof ResponseFinishedMessage>
  | Schema.Schema.Type<typeof RequestErrorMessage>
  | Schema.Schema.Type<typeof CancelledMessage>
  | Schema.Schema.Type<typeof PageLoadedMessage>
  | Schema.Schema.Type<typeof PageRequestedMessage>

type HostToWebMessage =
  | Schema.Schema.Type<typeof CancelSnifferRequestMessage>
  | Schema.Schema.Type<typeof PageActionMessage>

// Arbitrary instances of each decoded payload, derived from the schemas
// themselves so the test stays in lockstep with the bridge wire format —
// adding a new field on a message immediately widens the arbitrary, no
// hand-maintained fixtures.
const webToHostArb: fc.Arbitrary<WebToHostMessage> = fc.oneof(
  Arbitrary.make(Schema.typeSchema(ResponseStartMessage)),
  Arbitrary.make(Schema.typeSchema(ResponseDataMessage)),
  Arbitrary.make(Schema.typeSchema(ResponseFinishedMessage)),
  Arbitrary.make(Schema.typeSchema(RequestErrorMessage)),
  Arbitrary.make(Schema.typeSchema(CancelledMessage)),
  Arbitrary.make(Schema.typeSchema(PageLoadedMessage))
)

const hostToWebArb: fc.Arbitrary<HostToWebMessage> = fc.oneof(
  Arbitrary.make(Schema.typeSchema(CancelSnifferRequestMessage)),
  // The PageAction arbitrary spans both `action` kinds (Click / Fill) via the
  // schema-derived union, so the round-trip property exercises each.
  Arbitrary.make(Schema.typeSchema(PageActionMessage))
)

const encodeWebToHost = (m: WebToHostMessage): string => {
  switch (m._tag) {
    case 'ResponseStart':
      return Schema.encodeSync(ResponseStartMessage)(m)
    case 'ResponseData':
      return Schema.encodeSync(ResponseDataMessage)(m)
    case 'ResponseFinished':
      return Schema.encodeSync(ResponseFinishedMessage)(m)
    case 'RequestError':
      return Schema.encodeSync(RequestErrorMessage)(m)
    case 'Cancelled':
      return Schema.encodeSync(CancelledMessage)(m)
    case 'PageLoaded':
      return Schema.encodeSync(PageLoadedMessage)(m)
    case 'PageRequested':
      return Schema.encodeSync(PageRequestedMessage)(m)
    default: {
      const exhaustive: never = m
      throw new Error(`unreachable encodeWebToHost: ${JSON.stringify(exhaustive)}`)
    }
  }
}

// Drain sentinel: a side-neutral extra bridge whose lone message, appended
// after the real inputs, rides the FIFO inbox behind them. Its handler
// resolving proves every message ahead of it has been dispatched — the
// deterministic drain signal the removed `registerHandlers` barrier (and
// before it `transport.flushed`) used to provide. A distinct tag, so it never
// collides with a real sniffer message or pollutes the collected payloads.
const DrainToHost = Schema.parseJson(Schema.TaggedStruct('__DrainToHost__', {}))
const DrainToWeb = Schema.parseJson(Schema.TaggedStruct('__DrainToWeb__', {}))
const SentinelBridge = Bridge.make({
  name: 'DrainSentinel',
  hostToWeb: [['__DrainToWeb__', DrainToWeb]] as const,
  webToHost: [['__DrainToHost__', DrainToHost]] as const,
})
const drainToHostEncoded = Schema.encodeSync(DrainToHost)({ _tag: '__DrainToHost__' })
const drainToWebEncoded = Schema.encodeSync(DrainToWeb)({ _tag: '__DrainToWeb__' })

/**
 * Build a Host-side handler record where every webToHost handler
 * pushes the decoded payload onto a shared array. Returned alongside
 * the array so a caller can drive the transport then inspect what
 * landed.
 */
const makeCollectingHostHandlers = (): {
  collected: WebToHostMessage[]
  handlers: MessageHandler.HandlersFor<(typeof BrowserSnifferBridge)['WebToHost']>
} => {
  const collected: WebToHostMessage[] = []
  const push = (m: WebToHostMessage): Effect.Effect<void> =>
    Effect.sync(() => {
      collected.push(m)
    })
  const handlers: MessageHandler.HandlersFor<(typeof BrowserSnifferBridge)['WebToHost']> = {
    ResponseStart: push,
    ResponseData: push,
    ResponseFinished: push,
    RequestError: push,
    Cancelled: push,
    PageLoaded: push,
    PageRequested: push,
  }
  return { collected, handlers }
}

const runHost = async (
  inputs: string[],
  handlers: MessageHandler.HandlersFor<(typeof BrowserSnifferBridge)['WebToHost']>
): Promise<void> => {
  const { layer: adapterLayer } = TestPlatformAdapterLayer.make({
    initialMessages: [...inputs, drainToHostEncoded],
  })
  // Negative-path tests below intentionally feed malformed wire input, which
  // the bridge logs at WARN. Capture (and discard) those logs so the test
  // output stays quiet.
  const { layer: capturingLoggerLayer } = LoggingLayerTest.make()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const drained = yield* Deferred.make<void>()
        yield* BridgeTransport.makeHostTransport({
          bridges: [BrowserSnifferBridge, SentinelBridge] as const,
          handlers: [
            handlers,
            { __DrainToHost__: () => Deferred.succeed(drained, undefined).pipe(Effect.asVoid) },
          ] as const,
        })
        // `make` offers every drained initial message to the inbox before
        // returning; the sentinel rides the same FIFO inbox behind them, so
        // awaiting it proves they have all been dispatched.
        yield* Deferred.await(drained)
      }).pipe(Effect.provide(adapterLayer), Effect.provide(capturingLoggerLayer))
    )
  )
}

describe('BrowserSnifferBridge — shape', () => {
  test('declares the seven sniffer events on Web→Host and the two control messages on Host→Web', () => {
    expect(Object.keys(BrowserSnifferBridge.WebToHost).toSorted()).toEqual([
      'Cancelled',
      'PageLoaded',
      'PageRequested',
      'RequestError',
      'ResponseData',
      'ResponseFinished',
      'ResponseStart',
    ])
    expect(Object.keys(BrowserSnifferBridge.HostToWeb).toSorted()).toEqual([
      'CancelSnifferRequest',
      'PageAction',
    ])
  })
})

describe('BrowserSnifferBridge — Web→Host round-trip', () => {
  // Property: for any sequence of decoded Web→Host messages, encoding them
  // through the bridge schemas, feeding the wire strings to the
  // BridgeTransport via `TestPlatformAdapterLayer`, and collecting the
  // dispatched payloads in handler order should reproduce the original
  // sequence — both `_tag` and payload structure.
  test('every encoded message round-trips through dispatch by _tag with the payload preserved', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(webToHostArb), async (messages) => {
        const { collected, handlers } = makeCollectingHostHandlers()
        await runHost(messages.map(encodeWebToHost), handlers)
        expect(collected).toEqual(messages)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('BrowserSnifferBridge — Host→Web round-trip', () => {
  // Property: arbitrary CancelSnifferRequest / PageAction payloads dispatched
  // on the Web side reproduce on the handler verbatim. Mirrors the
  // Web→Host property — guards against the cancel / page-action contracts
  // drifting between host (typed sendMessage) and page (hand-decoded
  // `message`-event). PageAction spans both `action` kinds via the arbitrary.
  test('every encoded Host→Web payload round-trips through Web-side dispatch', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(hostToWebArb), async (messages) => {
        const collected: HostToWebMessage[] = []
        const push = (m: HostToWebMessage): Effect.Effect<void> =>
          Effect.sync(() => {
            collected.push(m)
          })
        const webHandlers: MessageHandler.HandlersFor<(typeof BrowserSnifferBridge)['HostToWeb']> =
          {
            CancelSnifferRequest: push,
            PageAction: push,
          }

        const encodeHostToWeb = (m: HostToWebMessage): string => {
          switch (m._tag) {
            case 'CancelSnifferRequest':
              return Schema.encodeSync(CancelSnifferRequestMessage)(m)
            case 'PageAction':
              return Schema.encodeSync(PageActionMessage)(m)
            default: {
              const exhaustive: never = m
              throw new Error(`unreachable encodeHostToWeb: ${JSON.stringify(exhaustive)}`)
            }
          }
        }
        const inputs = messages.map(encodeHostToWeb)
        const { layer: adapterLayer } = TestPlatformAdapterLayer.make({
          initialMessages: [...inputs, drainToWebEncoded],
        })

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const drained = yield* Deferred.make<void>()
              yield* BridgeTransport.makeWebTransport({
                bridges: [BrowserSnifferBridge, SentinelBridge] as const,
                handlers: [
                  webHandlers,
                  {
                    __DrainToWeb__: () => Deferred.succeed(drained, undefined).pipe(Effect.asVoid),
                  },
                ] as const,
              })
              // The sentinel rides the FIFO inbox behind the drained initial
              // messages, so awaiting it proves they have all been dispatched.
              yield* Deferred.await(drained)
            }).pipe(Effect.provide(adapterLayer))
          )
        )

        expect(collected).toEqual(messages)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  // Focused runner for the explicit PageAction cases below — mirrors
  // `runHost` on the Web side (drain sentinel rides the FIFO inbox behind
  // the inputs; the capturing logger swallows the negative-path WARNs).
  const runWeb = async (
    inputs: string[],
    handlers: MessageHandler.HandlersFor<(typeof BrowserSnifferBridge)['HostToWeb']>
  ): Promise<void> => {
    const { layer: adapterLayer } = TestPlatformAdapterLayer.make({
      initialMessages: [...inputs, drainToWebEncoded],
    })
    const { layer: capturingLoggerLayer } = LoggingLayerTest.make()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const drained = yield* Deferred.make<void>()
          yield* BridgeTransport.makeWebTransport({
            bridges: [BrowserSnifferBridge, SentinelBridge] as const,
            handlers: [
              handlers,
              { __DrainToWeb__: () => Deferred.succeed(drained, undefined).pipe(Effect.asVoid) },
            ] as const,
          })
          yield* Deferred.await(drained)
        }).pipe(Effect.provide(adapterLayer), Effect.provide(capturingLoggerLayer))
      )
    )
  }

  test('dispatches a Click-kind and a Fill-kind PageAction with the inner action preserved', async () => {
    const collected: HostToWebMessage[] = []
    const push = (m: HostToWebMessage): Effect.Effect<void> =>
      Effect.sync(() => {
        collected.push(m)
      })
    const clickAction: Schema.Schema.Type<typeof PageActionMessage> = {
      _tag: 'PageAction',
      action: { kind: 'Click', querySelector: '#go' },
    }
    const fillAction: Schema.Schema.Type<typeof PageActionMessage> = {
      _tag: 'PageAction',
      action: { kind: 'Fill', querySelector: '#user', value: 'alice' },
    }
    await runWeb(
      [
        Schema.encodeSync(PageActionMessage)(clickAction),
        Schema.encodeSync(PageActionMessage)(fillAction),
      ],
      { CancelSnifferRequest: push, PageAction: push }
    )
    expect(collected).toEqual([clickAction, fillAction])
  })

  test('drops a PageAction whose inner action fails the shape guard', async () => {
    const collected: HostToWebMessage[] = []
    const push = (m: HostToWebMessage): Effect.Effect<void> =>
      Effect.sync(() => {
        collected.push(m)
      })
    const valid: Schema.Schema.Type<typeof PageActionMessage> = {
      _tag: 'PageAction',
      action: { kind: 'Click', querySelector: '#ok' },
    }
    await runWeb(
      [
        // Unknown inner kind — not a union member.
        JSON.stringify({ _tag: 'PageAction', action: { kind: 'Scroll', querySelector: '#x' } }),
        // Click action missing the required querySelector.
        JSON.stringify({ _tag: 'PageAction', action: { kind: 'Click' } }),
        // Empty-string querySelector violates NonEmptyString.
        JSON.stringify({ _tag: 'PageAction', action: { kind: 'Click', querySelector: '' } }),
        // A well-formed message still makes it through.
        Schema.encodeSync(PageActionMessage)(valid),
      ],
      { CancelSnifferRequest: push, PageAction: push }
    )
    expect(collected).toEqual([valid])
  })
})

describe('BrowserSnifferBridge — Web→Host negative paths', () => {
  test('drops malformed JSON without dispatching to any handler', async () => {
    const { collected, handlers } = makeCollectingHostHandlers()
    await runHost(['{ not valid json }', '"plain string"', '12345', 'undefined'], handlers)
    expect(collected).toEqual([])
  })

  test('drops payloads with an unknown _tag', async () => {
    const { collected, handlers } = makeCollectingHostHandlers()
    await runHost(
      [
        JSON.stringify({ _tag: 'NotARealMessage', id: 'r1' }),
        JSON.stringify({ _tag: 'ResponseFinished', id: 'kept' }),
      ],
      handlers
    )
    expect(collected).toEqual([{ _tag: 'ResponseFinished', id: 'kept' }])
  })

  test('drops payloads that match a known _tag but fail field validation', async () => {
    const { collected, handlers } = makeCollectingHostHandlers()
    await runHost(
      [
        // Missing `id` field
        JSON.stringify({ _tag: 'ResponseFinished' }),
        // Empty-string id violates SnifferRequestId (NonEmptyString)
        JSON.stringify({ _tag: 'ResponseFinished', id: '' }),
        // Out-of-range status
        JSON.stringify({
          _tag: 'ResponseStart',
          id: 'r1',
          url: 'https://e/r1',
          status: 99999,
          statusText: 'OK',
          headers: [],
        }),
        // Wrong type for headers (Record was the old shape; new shape is Array of Tuple)
        JSON.stringify({
          _tag: 'ResponseStart',
          id: 'r2',
          url: 'https://e/r2',
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/plain' },
        }),
        // Valid message: makes it through
        JSON.stringify({ _tag: 'ResponseFinished', id: 'r-valid' }),
      ],
      handlers
    )
    expect(collected).toEqual([{ _tag: 'ResponseFinished', id: 'r-valid' }])
  })

  test('preserves ResponseStart → ResponseData → ResponseFinished ordering for the same id', async () => {
    const { collected, handlers } = makeCollectingHostHandlers()
    await runHost(
      [
        JSON.stringify({
          _tag: 'ResponseStart',
          id: 'a',
          url: 'https://e/a',
          method: 'GET',
          status: 200,
          statusText: 'OK',
          headers: [],
        }),
        JSON.stringify({ _tag: 'ResponseData', id: 'a', data: 'aGVsbG8=' }),
        JSON.stringify({ _tag: 'ResponseFinished', id: 'a' }),
      ],
      handlers
    )
    expect(collected.map((m) => m._tag)).toEqual([
      'ResponseStart',
      'ResponseData',
      'ResponseFinished',
    ])
  })

  test('preserves dispatch order even when two id streams interleave', async () => {
    const { collected, handlers } = makeCollectingHostHandlers()
    await runHost(
      [
        JSON.stringify({
          _tag: 'ResponseStart',
          id: 'a',
          url: 'https://e/a',
          method: 'GET',
          status: 200,
          statusText: 'OK',
          headers: [],
        }),
        JSON.stringify({
          _tag: 'ResponseStart',
          id: 'b',
          url: 'https://e/b',
          method: 'GET',
          status: 200,
          statusText: 'OK',
          headers: [],
        }),
        JSON.stringify({ _tag: 'ResponseData', id: 'a', data: 'YQ==' }),
        JSON.stringify({ _tag: 'ResponseData', id: 'b', data: 'Yg==' }),
        JSON.stringify({ _tag: 'ResponseFinished', id: 'b' }),
        JSON.stringify({ _tag: 'ResponseFinished', id: 'a' }),
      ],
      handlers
    )
    // Wire order is preserved end-to-end; consumers correlate by id.
    expect(collected.map((m) => [m._tag, 'id' in m ? m.id : undefined])).toEqual([
      ['ResponseStart', 'a'],
      ['ResponseStart', 'b'],
      ['ResponseData', 'a'],
      ['ResponseData', 'b'],
      ['ResponseFinished', 'b'],
      ['ResponseFinished', 'a'],
    ])
  })
})
