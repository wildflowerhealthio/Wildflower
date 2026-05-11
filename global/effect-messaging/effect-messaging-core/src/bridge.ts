import { Array, Context, Effect, Layer, Option, Schema } from 'effect'
import type { UnionToIntersection } from 'kitchen-sink/types'
import type * as MessageHandler from './message-handler.ts'
import * as Message from './message.ts'
import { TransportAdapter } from './transport-adapter.ts'

/** Typed sender for one side. Each call returns an Effect that requires {@link TransportAdapter}. */
type SenderFn<R extends Message.SchemaRecord> = (
  message: Message.Of<R>
) => Effect.Effect<void, never, TransportAdapter>

/** One side of a bridge. `Outbound` is what this side sends; `Inbound` is what it receives. */
interface Half<
  Name extends string,
  Side extends 'Host' | 'Web',
  Outbound extends Message.SchemaRecord,
  Inbound extends Message.SchemaRecord,
> {
  readonly OutboundSchemas: Outbound
  readonly InboundSchemas: Inbound
  readonly HandlerTag: Context.Tag<
    MessageHandler.TagId<Name, Side>,
    MessageHandler.HandlersFor<Inbound>
  >
  readonly ReceiverLayer: (
    handlers: MessageHandler.HandlersFor<Inbound>
  ) => Layer.Layer<MessageHandler.TagId<Name, Side>>
  readonly send: SenderFn<Outbound>
}

/**
 * Optional per-tag schemas for encoding messages as URL query params
 * (the `?<Tag>=<value>` form on the WebView's source URL). Keys must be
 * a subset of the bridge's host→web tag names; each value is a
 * `Schema<MessageOf<Tag>, string>` — encoded form is the URL-param
 * value, decoded form is the typed message (with `_tag` populated).
 *
 * Tags without an entry can't ride on URL params. Use {@link singleStringMessageSchema}
 * for the common single-string-field case.
 */
type UrlParamSchemas<HostToWeb extends Message.SchemaRecord> = {
  readonly [Tag in keyof HostToWeb]?: HostToWeb[Tag] extends Schema.Schema<infer A, string, never>
    ? Schema.Schema<A, string, never>
    : never
}

/** A bridge's two halves plus its name. */
interface Bridge<
  Name extends string,
  HostToWeb extends Message.SchemaRecord,
  WebToHost extends Message.SchemaRecord,
> {
  readonly name: Name
  readonly Host: Half<Name, 'Host', HostToWeb, WebToHost>
  readonly Web: Half<Name, 'Web', WebToHost, HostToWeb>
  readonly MessageSchemas: HostToWeb & WebToHost
  readonly UrlParamSchemas: UrlParamSchemas<HostToWeb>
}

/**
 * Structural bound for "any half of a bridge a transport can drive".
 *
 * @remarks
 * `Context.Tag<any, any>` and `(m: never) => …` widen invariant
 * positions so concrete halves fit. See `README.md` for the full
 * variance write-up.
 */
type AnyHalf = {
  readonly InboundSchemas: Message.SchemaRecord
  readonly OutboundSchemas: Message.SchemaRecord
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly HandlerTag: Context.Tag<any, any>
  readonly send: (m: never) => Effect.Effect<void, never, TransportAdapter>
}

/** Structural bound for "any wired bridge". */
type AnyBridge = {
  readonly name: string
  readonly Host: AnyHalf
  readonly Web: AnyHalf
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly UrlParamSchemas: Readonly<Record<string, Schema.Schema<any, string, never> | undefined>>
}

/**
 * Function-intersection of every wired bridge's typed sender for the
 * specified side. The transport's public `sendMessage` strips the
 * {@link TransportAdapter} requirement.
 */
type MessageSender<
  Bridges extends ReadonlyArray<AnyBridge>,
  Side extends 'Host' | 'Web',
> = UnionToIntersection<
  Bridges[number] extends infer B
    ? B extends {
        readonly [K in Side]: {
          readonly send: (
            m: infer M extends { readonly _tag: string }
          ) => Effect.Effect<void, never, TransportAdapter>
        }
      }
      ? (message: M) => Effect.Effect<void>
      : never
    : never
>

/**
 * Union of every decoded message a wired bridge's `Side` can send.
 *
 * @remarks
 * Used where {@link MessageSender}'s function-intersection shape
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
        ) => Effect.Effect<void, never, TransportAdapter>
      }
    }
    ? M
    : never
  : never

/**
 * Union of decoded message types whose tags have a `urlParams` schema
 * declared on some wired bridge. The Expo transport's `initialMessages`
 * narrows to this so call sites can't pass a tag that has no URL form.
 *
 * @remarks
 * Each `urlParams[Tag]` is `Schema | undefined` because the field is
 * optional on `Bridge.make` config — `NonNullable` strips the
 * `undefined` so the `infer A` branch can extract the message type.
 */
type UrlParamableMessage<Bridges extends ReadonlyArray<AnyBridge>> = Bridges[number] extends infer B
  ? B extends { readonly UrlParamSchemas: infer UP }
    ? {
        [Tag in keyof UP]: NonNullable<UP[Tag]> extends Schema.Schema<infer A, string, never>
          ? A extends { readonly _tag: string }
            ? A
            : never
          : never
      }[keyof UP]
    : never
  : never

/**
 * Tuple-mapped layers requirement for a bridge transport. Position `I` must
 * supply position `I`'s bridge tag (for the specified side).
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
 *   urlParams: {
 *     HostRequestedWebNavigation: singleStringMessageSchema('HostRequestedWebNavigation', 'path'),
 *   },
 * })
 * ```
 *
 * @remarks
 * Each call mints fresh `Context.Tag` instances. Pair tuples are
 * validated via {@link Message.ValidatedPairs} — a mismatched
 * `[tag, schema]` fails at the call site. `urlParams` is optional;
 * tags without a urlParams schema can't ride on the WebView source URL.
 */
const make = <
  const Name extends string,
  const HostToWebPairs extends ReadonlyArray<readonly [string, Message.AnyStringEncodedSchema]>,
  const WebToHostPairs extends ReadonlyArray<readonly [string, Message.AnyStringEncodedSchema]>,
>(definition: {
  readonly name: Name
  readonly hostToWeb: HostToWebPairs & Message.ValidatedPairs<HostToWebPairs>
  readonly webToHost: WebToHostPairs & Message.ValidatedPairs<WebToHostPairs>
  readonly urlParams?: UrlParamSchemas<Message.RecordFromPairs<HostToWebPairs>>
}): Bridge<
  Name,
  Message.RecordFromPairs<HostToWebPairs>,
  Message.RecordFromPairs<WebToHostPairs>
> => {
  const hostToWebRecord = Message.recordFromPairs<HostToWebPairs>(definition.hostToWeb)
  const webToHostRecord = Message.recordFromPairs<WebToHostPairs>(definition.webToHost)

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
        // `message` is `Message.Of<...>` (abstract); runtime invariant: every value is a tagged struct.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        sendThrough(hostToWebRecord, message as { readonly _tag: string }),
    },
    Web: {
      OutboundSchemas: webToHostRecord,
      InboundSchemas: hostToWebRecord,
      HandlerTag: WebHandlerTag,
      ReceiverLayer: (handlers) => Layer.succeed(WebHandlerTag, handlers),
      send: (message) =>
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        sendThrough(webToHostRecord, message as { readonly _tag: string }),
    },
    MessageSchemas: {
      ...hostToWebRecord,
      ...webToHostRecord,
    },
    UrlParamSchemas: definition.urlParams ?? {},
  }
}

/**
 * Look up a message's outbound schema by tag, encode, and forward through
 * the {@link TransportAdapter}. Unknown tags warn and drop.
 */
const sendThrough = (
  record: Record<string, Message.AnyStringEncodedSchema>,
  message: { readonly _tag: string }
): Effect.Effect<void, never, TransportAdapter> =>
  Effect.gen(function* () {
    const schema = record[message._tag]
    if (schema === undefined) {
      yield* Effect.logWarning(
        `[effect-messaging] sendMessage: no outbound schema for "${message._tag}"; dropping`
      )
      return undefined
    }
    const adapter = yield* TransportAdapter
    yield* adapter.bareSender(Schema.encodeSync(schema)(message))
    return undefined
  })

type AnyTaggedMessageSender = (message: {
  readonly _tag: string
}) => Effect.Effect<void, never, TransportAdapter>

/**
 * Build a `{[tag]: bridgeSenderForTag}` map across a list of bridges for one
 * side. Throws on outbound-tag collisions — same wiring-error policy the
 * transport's inbound dup check enforces.
 */
const senderByTag = (
  bridges: ReadonlyArray<AnyBridge>,
  side: 'Host' | 'Web'
): Map<string, AnyTaggedMessageSender> => {
  const map = new Map<string, AnyTaggedMessageSender>()
  for (const bridge of bridges) {
    const half = bridge[side]
    for (const tag of Object.keys(half.OutboundSchemas)) {
      if (map.has(tag)) {
        throw new Error(`[effect-messaging] duplicate outbound tag "${tag}" across bridges`)
      }
      // `half.send` is typed `(m: never) => …`; runtime dispatch by `_tag` lands every message correctly.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      map.set(tag, half.send as AnyTaggedMessageSender)
    }
  }
  return map
}

/**
 * Look up the URL-param schema for a tag across a list of bridges.
 * Throws on duplicate-tag conflicts so wiring drift fails synchronously.
 */
const findUrlParamSchema = (
  bridges: ReadonlyArray<AnyBridge>,
  tag: string
): Message.AnyStringEncodedSchema | undefined => {
  const matchingUrlParamSchemas = Array.filterMap(bridges, (bridge) =>
    Option.fromNullable(bridge.UrlParamSchemas[tag])
  )
  if (matchingUrlParamSchemas.length > 1) {
    throw new Error(`[effect-messaging] duplicate urlParams tag "${tag}" across bridges`)
  } else if (matchingUrlParamSchemas.length === 1) {
    return matchingUrlParamSchemas[0]
  } else {
    return undefined
  }
}

/**
 * Look up the wire (host→web) schema for a tag across the bridges.
 * Used by the URL decoder to re-encode the decoded message as the
 * canonical wire JSON the dispatch fiber consumes.
 */
const findWireSchema = (
  bridges: ReadonlyArray<AnyBridge>,
  tag: string
): Message.AnyStringEncodedSchema | undefined => {
  for (const bridge of bridges) {
    const schema = bridge.Web.InboundSchemas[tag]
    if (schema !== undefined) return schema
  }
  return undefined
}

export { make, senderByTag, findUrlParamSchema, findWireSchema }
export type {
  AnyBridge,
  AnyHalf,
  Bridge,
  Half,
  MessageSender,
  SendableMessage,
  SenderFn,
  TransportLayers,
  UrlParamableMessage,
  UrlParamSchemas,
}
