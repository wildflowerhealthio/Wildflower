import { Context, Effect, Layer, Schema } from 'effect'
import type { UnionToIntersection } from 'kitchen-sink/types'
import type * as MessageHandler from './message-handler.ts'
import type * as Message from './message.ts'
import { PlatformAdapter } from './platform-adapter.ts'

/**
 * The slice-paired primitive that binds outbound senders to inbound
 * receivers at the type level. Re-exported as the `Bridge` namespace
 * from `effect-messaging-core`. Construct with {@link make}.
 */

/** Typed sender for one side. Each call returns an Effect that requires {@link PlatformAdapter}. */
type SenderFn<R extends Message.SchemaRecord> = (
  message: Message.Of<R>
) => Effect.Effect<void, never, PlatformAdapter>

/** One side of a bridge. `Outbound` is what this side sends; `Inbound` is what it receives. */
interface Half<
  Name extends string,
  Side extends 'Host' | 'Web',
  Outbound extends Message.SchemaRecord,
  Inbound extends Message.SchemaRecord,
  Options extends Message.OptionsShape,
> {
  readonly OutboundSchemas: Outbound
  readonly InboundSchemas: Inbound

  /** Fresh-per-call `Context.Tag` for this side's typed handler record. */
  readonly HandlerTag: Context.Tag<
    MessageHandler.TagId<Name, Side>,
    MessageHandler.HandlersFor<Inbound>
  >

  /** Build a `Layer` that supplies `HandlerTag` with the caller's handlers. */
  readonly ReceiverLayer: (
    handlers: MessageHandler.HandlersFor<Inbound>
  ) => Layer.Layer<MessageHandler.TagId<Name, Side>>

  /** Typed sender for this side's outbound messages. Requires {@link PlatformAdapter} from context. */
  readonly send: SenderFn<Outbound>

  /** Schema describing the options the aggregator on this side expects when wiring this bridge. */
  readonly OptionsShape: Options
}

/** A bridge's two halves plus its name. */
interface Bridge<
  Name extends string,
  HostToWeb extends Message.SchemaRecord,
  WebToHost extends Message.SchemaRecord,
  HostOptions extends Message.OptionsShape,
  WebOptions extends Message.OptionsShape,
> {
  readonly name: Name
  readonly Host: Half<Name, 'Host', HostToWeb, WebToHost, HostOptions>
  readonly Web: Half<Name, 'Web', WebToHost, HostToWeb, WebOptions>
  readonly MessageSchemas: HostToWeb & WebToHost
}

/**
 * Structural bound for "any half of a bridge a transport can drive".
 *
 * @remarks
 * Concrete `Half<...>` values fit via structural typing. `Half`'s
 * schema/options generics appear in covariant *and* contravariant
 * positions across the two sides of the bridge so it's invariant;
 * `Context.Tag<any, any>` lets a concrete tag through Tag's own
 * invariant bound. The `send` argument is `never` so concrete senders
 * — including empty-outbound bridges typed `(m: never) => ...` —
 * fit via function-parameter contravariance.
 */
type AnyHalf = {
  readonly InboundSchemas: Message.SchemaRecord
  readonly OutboundSchemas: Message.SchemaRecord
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly HandlerTag: Context.Tag<any, any>
  readonly send: (m: never) => Effect.Effect<void, never, PlatformAdapter>
}

/** Structural bound for "any wired bridge". */
type AnyBridge = {
  readonly name: string
  readonly Host: AnyHalf
  readonly Web: AnyHalf
}

/**
 * Function-intersection of every wired bridge's typed sender for the
 * specified side. The transport's public `sendMessage` strips the
 * {@link PlatformAdapter} requirement (the transport provides it
 * internally), so the surfaced shape is `(m) => Effect<void>` per
 * bridge.
 */
type SenderIntersection<
  Bridges extends ReadonlyArray<AnyBridge>,
  Side extends 'Host' | 'Web',
> = UnionToIntersection<
  Bridges[number] extends infer B
    ? B extends {
        readonly [K in Side]: {
          readonly send: (
            m: infer M extends { readonly _tag: string }
          ) => Effect.Effect<void, never, PlatformAdapter>
        }
      }
      ? (message: M) => Effect.Effect<void>
      : never
    : never
>

/**
 * Union of every decoded message a wired bridge's `Side` can send.
 * Used where {@link SenderIntersection}'s function-intersection shape
 * is the wrong tool — `Parameters` doesn't yield a parameter union
 * over intersected functions because TS treats them as overloads.
 */
type SendableMessage<
  Bridges extends ReadonlyArray<AnyBridge>,
  Side extends 'Host' | 'Web',
> = Bridges[number] extends infer B
  ? B extends {
      readonly [K in Side]: {
        readonly send: (
          m: infer M extends { readonly _tag: string }
        ) => Effect.Effect<void, never, PlatformAdapter>
      }
    }
    ? M
    : never
  : never

/**
 * Tuple-mapped layers requirement for a bridge transport. Position
 * `I` must supply position `I`'s bridge tag (for the specified side);
 * mismatched lengths or tag identifiers fail at the call site.
 */
type TransportLayers<Bridges extends ReadonlyArray<AnyBridge>, Side extends 'Host' | 'Web'> = {
  readonly [I in keyof Bridges]: Bridges[I] extends {
    // oxlint-disable-next-line typescript/no-explicit-any
    readonly [K in Side]: { readonly HandlerTag: Context.Tag<infer Id, any> }
  }
    ? Layer.Layer<Id>
    : never
}

/**
 * Declare a typed cross-process message bridge.
 *
 * @example
 * ```ts
 * const NavigationBridge = Bridge.make({
 *   name: 'Navigation',
 *   hostToWeb: [['HostBackRequested', HostBackRequested]] as const,
 *   webToHost: [['RouteChanged', RouteChanged]] as const,
 *   hostOptionsShape: Schema.Struct({ initialPath: Schema.String }),
 *   webOptionsShape: Schema.Struct({}),
 * })
 * ```
 *
 * @remarks
 * Each call mints two fresh `Context.Tag` instances — runtime
 * identities are unique per call, even with the same `name`. Pair
 * tuples are validated via {@link Message.ValidatedPairs} — a
 * mismatched `[tag, schema]` is a compile error at the call site.
 */
const make = <
  const Name extends string,
  const HostToWebPairs extends ReadonlyArray<readonly [string, Message.StringEncodedSchema]>,
  const WebToHostPairs extends ReadonlyArray<readonly [string, Message.StringEncodedSchema]>,
  HostOptions extends Message.OptionsShape,
  WebOptions extends Message.OptionsShape,
>(definition: {
  readonly name: Name
  readonly hostToWeb: HostToWebPairs & Message.ValidatedPairs<HostToWebPairs>
  readonly webToHost: WebToHostPairs & Message.ValidatedPairs<WebToHostPairs>
  readonly hostOptionsShape: HostOptions
  readonly webOptionsShape: WebOptions
}): Bridge<
  Name,
  Message.RecordFromPairs<HostToWebPairs>,
  Message.RecordFromPairs<WebToHostPairs>,
  HostOptions,
  WebOptions
> => {
  const hostToWebRecord = recordFromPairs<HostToWebPairs>(definition.hostToWeb)
  const webToHostRecord = recordFromPairs<WebToHostPairs>(definition.webToHost)

  const HostHandlerTag = Context.GenericTag<
    MessageHandler.TagId<Name, 'Host'>,
    MessageHandler.HandlersFor<Message.RecordFromPairs<WebToHostPairs>>
  >(`${definition.name}.Host.HandlerTag`)

  const WebHandlerTag = Context.GenericTag<
    MessageHandler.TagId<Name, 'Web'>,
    MessageHandler.HandlersFor<Message.RecordFromPairs<HostToWebPairs>>
  >(`${definition.name}.Web.HandlerTag`)

  return {
    name: definition.name,
    Host: {
      OutboundSchemas: hostToWebRecord,
      InboundSchemas: webToHostRecord,
      HandlerTag: HostHandlerTag,
      ReceiverLayer: (handlers) => Layer.succeed(HostHandlerTag, handlers),
      send: (message) =>
        // `message` is contextually typed as `Message.Of<...>`; abstract
        // inside this body, so TS can't reduce it to a `_tag`-bearing
        // shape. Runtime invariant: every value is a tagged struct.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        sendThrough(hostToWebRecord, message as { readonly _tag: string }),
      OptionsShape: definition.hostOptionsShape,
    },
    Web: {
      OutboundSchemas: webToHostRecord,
      InboundSchemas: hostToWebRecord,
      HandlerTag: WebHandlerTag,
      ReceiverLayer: (handlers) => Layer.succeed(WebHandlerTag, handlers),
      send: (message) =>
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        sendThrough(webToHostRecord, message as { readonly _tag: string }),
      OptionsShape: definition.webOptionsShape,
    },
    MessageSchemas: {
      ...hostToWebRecord,
      ...webToHostRecord,
    },
  }
}

/**
 * Build a `{[tag]: schema}` record from a pair tuple. Caller's precise
 * types survive via the `RecordFromPairs<...>` cast in {@link make}'s
 * return — this helper has no per-pair type info to thread through.
 */
const recordFromPairs = <
  TPairs extends ReadonlyArray<readonly [string, Message.StringEncodedSchema]>,
>(
  pairs: TPairs
): Message.RecordFromPairs<TPairs> => {
  const record: Record<string, Message.StringEncodedSchema> = {}
  for (const [tag, schema] of pairs) record[tag] = schema
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return record as Message.RecordFromPairs<TPairs>
}

/**
 * Look up a message's outbound schema by tag, encode it, and forward
 * the resulting string through the {@link PlatformAdapter} the
 * caller's Effect context provides. Unknown tags warn and drop —
 * a wiring mistake.
 */
const sendThrough = (
  record: Record<string, Message.StringEncodedSchema>,
  message: { readonly _tag: string }
): Effect.Effect<void, never, PlatformAdapter> =>
  Effect.gen(function* () {
    const schema = record[message._tag]
    if (schema === undefined) {
      yield* Effect.logWarning(
        `[effect-messaging] sendMessage: no outbound schema for "${message._tag}"; dropping`
      )
      return undefined
    }
    const adapter = yield* PlatformAdapter
    yield* adapter.bareSender(Schema.encodeSync(schema)(message))
    return undefined
  })

/**
 * Build a `{[tag]: bridgeSenderForTag}` map across a list of bridges
 * for one side. Throws synchronously on outbound-tag collisions
 * across bridges — same wiring-error policy the transport's inbound
 * dup check enforces.
 *
 * @remarks
 * Used both by `BridgeTransport.make`'s dispatch surface and by Expo's
 * initial-message encoder so the two paths agree on the per-tag
 * sender (and so duplicates throw once, in this helper).
 */
type TaggedSender = (message: {
  readonly _tag: string
}) => Effect.Effect<void, never, PlatformAdapter>

const senderByTag = <Bridges extends ReadonlyArray<AnyBridge>, Side extends 'Host' | 'Web'>(
  bridges: Bridges,
  side: Side
): Map<string, TaggedSender> => {
  const map = new Map<string, TaggedSender>()
  for (const bridge of bridges) {
    const half = bridge[side]
    for (const tag of Object.keys(half.OutboundSchemas)) {
      if (map.has(tag)) {
        throw new Error(`[effect-messaging] duplicate outbound tag "${tag}" across bridges`)
      }
      // `half.send` is typed `(m: never) => ...` — the structural escape;
      // dispatching by `_tag` lands every message on a sender that
      // accepts it at runtime.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      map.set(tag, half.send as TaggedSender)
    }
  }
  return map
}

export { make, senderByTag }
export type {
  AnyBridge,
  AnyHalf,
  Bridge,
  Half,
  SendableMessage,
  SenderFn,
  SenderIntersection,
  TaggedSender,
  TransportLayers,
}
