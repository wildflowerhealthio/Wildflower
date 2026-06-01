import { Arbitrary, Deferred, Effect, Schema } from 'effect'
import { Bridge, BridgeTransport, type MessageHandler } from 'effect-messaging-core'
import * as TestPlatformAdapterLayer from 'effect-messaging-core/test'
import * as fc from 'fast-check'
import { LoggingLayerTest, numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import { BrowserSnifferBridge } from './bridge.ts'
import {
  CancelSnifferRequestMessage,
  CancelledMessage,
  ClickMessage,
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

type HostToWebMessage =
  | Schema.Schema.Type<typeof CancelSnifferRequestMessage>
  | Schema.Schema.Type<typeof ClickMessage>

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
  Arbitrary.make(Schema.typeSchema(ClickMessage))
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
  test('declares the six sniffer events on Web→Host and the two control messages on Host→Web', () => {
    expect(Object.keys(BrowserSnifferBridge.WebToHost).toSorted()).toEqual([
      'Cancelled',
      'PageLoaded',
      'RequestError',
      'ResponseData',
      'ResponseFinished',
      'ResponseStart',
    ])
    expect(Object.keys(BrowserSnifferBridge.HostToWeb).toSorted()).toEqual([
      'CancelSnifferRequest',
      'Click',
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
  // Property: arbitrary CancelSnifferRequest / Click payloads dispatched
  // on the Web side reproduce on the handler verbatim. Mirrors the
  // Web→Host property — guards against the cancel / click contracts
  // drifting between host (typed sendMessage) and page (hand-decoded
  // `message`-event).
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
            Click: push,
          }

        const inputs = messages.map((m) =>
          m._tag === 'CancelSnifferRequest'
            ? Schema.encodeSync(CancelSnifferRequestMessage)(m)
            : Schema.encodeSync(ClickMessage)(m)
        )
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
          status: 200,
          statusText: 'OK',
          headers: [],
        }),
        JSON.stringify({
          _tag: 'ResponseStart',
          id: 'b',
          url: 'https://e/b',
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
