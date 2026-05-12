import { Arbitrary, Effect, Schema } from 'effect'
import { BridgeTransport, TestPlatformAdapterLayer } from 'effect-messaging-core'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'
import BrowserSnifferBridge from '../src/bridge.ts'
import {
  CancelSnifferRequestMessage,
  LogMessage,
  PageLoadedMessage,
  RequestErrorMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  ResponseStartMessage,
} from '../src/messages.ts'

type WebToHostMessage =
  | Schema.Schema.Type<typeof LogMessage>
  | Schema.Schema.Type<typeof ResponseStartMessage>
  | Schema.Schema.Type<typeof ResponseDataMessage>
  | Schema.Schema.Type<typeof ResponseFinishedMessage>
  | Schema.Schema.Type<typeof RequestErrorMessage>
  | Schema.Schema.Type<typeof PageLoadedMessage>

type HostToWebMessage = Schema.Schema.Type<typeof CancelSnifferRequestMessage>

// Arbitrary instances of each decoded payload, derived from the schemas
// themselves so the test stays in lockstep with the bridge wire format —
// adding a new field on a message immediately widens the arbitrary, no
// hand-maintained fixtures.
const webToHostArb: fc.Arbitrary<WebToHostMessage> = fc.oneof(
  Arbitrary.make(Schema.typeSchema(LogMessage)),
  Arbitrary.make(Schema.typeSchema(ResponseStartMessage)),
  Arbitrary.make(Schema.typeSchema(ResponseDataMessage)),
  Arbitrary.make(Schema.typeSchema(ResponseFinishedMessage)),
  Arbitrary.make(Schema.typeSchema(RequestErrorMessage)),
  Arbitrary.make(Schema.typeSchema(PageLoadedMessage))
)

const hostToWebArb: fc.Arbitrary<HostToWebMessage> = Arbitrary.make(
  Schema.typeSchema(CancelSnifferRequestMessage)
)

const encodeWebToHost = (m: WebToHostMessage): string => {
  switch (m._tag) {
    case 'Log':
      return Schema.encodeSync(LogMessage)(m)
    case 'ResponseStart':
      return Schema.encodeSync(ResponseStartMessage)(m)
    case 'ResponseData':
      return Schema.encodeSync(ResponseDataMessage)(m)
    case 'ResponseFinished':
      return Schema.encodeSync(ResponseFinishedMessage)(m)
    case 'RequestError':
      return Schema.encodeSync(RequestErrorMessage)(m)
    case 'PageLoaded':
      return Schema.encodeSync(PageLoadedMessage)(m)
    default: {
      const exhaustive: never = m
      throw new Error(`unreachable encodeWebToHost: ${JSON.stringify(exhaustive)}`)
    }
  }
}

describe('BrowserSnifferBridge — shape', () => {
  test('declares the six sniffer events on Web→Host and the cancel control on Host→Web', () => {
    expect(Object.keys(BrowserSnifferBridge.Web.OutboundSchemas).toSorted()).toEqual([
      'Log',
      'PageLoaded',
      'RequestError',
      'ResponseData',
      'ResponseFinished',
      'ResponseStart',
    ])
    expect(Object.keys(BrowserSnifferBridge.Host.OutboundSchemas)).toEqual(['CancelSnifferRequest'])
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
        const collected: WebToHostMessage[] = []
        const layer = BrowserSnifferBridge.Host.ReceiverLayer({
          Log: (m) =>
            Effect.sync(() => {
              collected.push(m)
            }),
          ResponseStart: (m) =>
            Effect.sync(() => {
              collected.push(m)
            }),
          ResponseData: (m) =>
            Effect.sync(() => {
              collected.push(m)
            }),
          ResponseFinished: (m) =>
            Effect.sync(() => {
              collected.push(m)
            }),
          RequestError: (m) =>
            Effect.sync(() => {
              collected.push(m)
            }),
          PageLoaded: (m) =>
            Effect.sync(() => {
              collected.push(m)
            }),
        })

        const inputs = messages.map(encodeWebToHost)
        const { layer: adapterLayer } = TestPlatformAdapterLayer.make({
          initialMessages: inputs,
        })

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const transport = yield* BridgeTransport.make({
                bridges: [BrowserSnifferBridge] as const,
                layers: [layer] as const,
                side: 'Host',
              })
              yield* transport.flushed
            }).pipe(Effect.provide(adapterLayer))
          )
        )

        expect(collected).toEqual(messages)
      })
    )
  })
})

describe('BrowserSnifferBridge — Host→Web round-trip', () => {
  // Property: arbitrary CancelSnifferRequest payloads dispatched on the
  // Web side reproduce on the handler verbatim. Mirrors the Web→Host
  // property — guards against the cancellation contract drifting between
  // host (typed sendMessage) and page (hand-decoded `message`-event).
  test('every encoded CancelSnifferRequest round-trips through Web-side dispatch', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(hostToWebArb), async (messages) => {
        const collected: HostToWebMessage[] = []
        const layer = BrowserSnifferBridge.Web.ReceiverLayer({
          CancelSnifferRequest: (m) =>
            Effect.sync(() => {
              collected.push(m)
            }),
        })

        const inputs = messages.map((m) => Schema.encodeSync(CancelSnifferRequestMessage)(m))
        const { layer: adapterLayer } = TestPlatformAdapterLayer.make({
          initialMessages: inputs,
        })

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const transport = yield* BridgeTransport.make({
                bridges: [BrowserSnifferBridge] as const,
                layers: [layer] as const,
                side: 'Web',
              })
              yield* transport.flushed
            }).pipe(Effect.provide(adapterLayer))
          )
        )

        expect(collected).toEqual(messages)
      })
    )
  })
})
