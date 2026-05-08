import { Context, Effect, Layer, Schema } from 'effect'
import type { UnionToIntersection } from 'kitchen-sink/types'
import type * as MessageHandler from './message-handler.ts'
import type * as Message from './message.ts'
import { PlatformAdapter } from './platform-adapter.ts'

/**
 * The slice-paired primitive that binds outbound senders to inbound
 * receivers at the type level. A bridge declares both directions in
 * one place; transports compose multiple bridges to produce a single
 * typed `sendMessage` and a merged Effect Context of receiver layers.
 *
 * Senders read the underlying byte sink from {@link PlatformAdapter}
 * — a `Context.Tag` aggregators provide via `Layer.succeed(...)`. The
 * bridge type carries the requirement; tests swap the adapter without
 * touching call sites.
 *
 * Re-exported as the `Bridge` namespace from `effect-messaging-core`'s
 * barrel. Construct with {@link make}; the resulting value's type is
 * `Bridge.Bridge<...>`.
 */

/**
 * Typed sender for one side. Each call returns an Effect that
 * requires {@link PlatformAdapter} from context — aggregators provide
 * the adapter once via Layer and the same sender encodes against
 * either a live byte sink or a capturing test stub. Aggregators merge
 * multiple bridges' senders via type intersection: TS treats
 * `((a: A) => Effect<void, never, R>) & ((b: B) => Effect<void, never, R>)`
 * as an overloaded function callable with either `A` or `B`.
 */
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

  /**
   * Typed sender for this side's outbound messages. Each call returns
   * an Effect that requires {@link PlatformAdapter} from context;
   * aggregators provide the adapter once via Layer and merge multiple
   * bridges' senders via type intersection.
   */
  readonly send: SenderFn<Outbound>

  /** Schema describing the options the aggregator on this side expects when wiring this bridge. */
  readonly OptionsShape: Options

  /**
   * Phantom values — runtime `undefined`, typed for indexing with
   * `typeof bridge.Host.SenderType` etc. Calling them or treating
   * them as data crashes; they exist only to surface types without
   * an intermediate `Schema.Schema.Type<...>` indirection. Confined
   * to this file; not used as a generic escape hatch.
   */
  readonly HandlerType: MessageHandler.HandlersFor<Inbound>
  readonly SendableMessageType: Message.Of<Outbound>
  readonly SenderType: SenderFn<Outbound>
  readonly OptionsType: Schema.Schema.Type<Options>
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
 * Concrete `Half<...>` values fit via structural typing — extra fields
 * (`HandlerType`, `SenderType`, etc.) are ignored.
 *
 * Why structural and not the parameterised `Half<...>` directly:
 * `Half`'s schema/options generics appear in covariant *and*
 * contravariant positions across the two sides of the bridge, so it's
 * invariant. `Context.Tag<any, any>` here uses `Tag`'s own variance
 * escape — `Tag` is invariant in both `Id` and `Service`, so `any` is
 * the only way to admit a concrete tag through this bound.
 */
type AnyHalf = {
  readonly InboundSchemas: Message.SchemaRecord
  readonly OutboundSchemas: Message.SchemaRecord
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly HandlerTag: Context.Tag<any, any>
  // The argument type is `never` so concrete senders — including
  // `(m: SpecificUnion) => Effect<void, never, PlatformAdapter>`
  // (concrete outbound) and `(m: never) => Effect<...>` (empty
  // outbound) — both fit under function-parameter contravariance.
  // Precise sender types are recovered at type-derivation sites via
  // `infer`.
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
 * specified side. Extracted from the concrete bridges via `infer` so
 * the precise per-bridge outbound types survive the structural
 * `AnyBridge` bound. The transport's public `sendMessage` strips the
 * {@link PlatformAdapter} requirement (the transport provides the
 * adapter internally via `Effect.provideService`); the surfaced shape
 * is a plain `(m) => Effect<void>` per bridge.
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
 * Used by transports that need a typed input list — e.g. the Expo
 * transport's `initialMessages: ReadonlyArray<SendableMessage<Bridges, 'Host'>>`
 * — where {@link SenderIntersection}'s function-intersection shape is
 * the wrong tool (intersected functions don't yield their parameter
 * union via `Parameters`, since TS treats the intersection as
 * overloads).
 */
type SendableMessage<
  Bridges extends ReadonlyArray<AnyBridge>,
  Side extends 'Host' | 'Web',
> = Bridges[number] extends infer B
  ? B extends {
      readonly [K in Side]: {
        readonly send: (
          // The `infer M extends ...` form pins the inferred type to
          // the bridge invariant: every wired message has a string
          // `_tag`. Without the constraint, callers that loop over
          // the union can't access `_tag` without a cast.
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
 * mismatched lengths or tag identifiers fail at the call site. The
 * `Id` is `infer`-extracted from the concrete bridge so the precise
 * tag identifier (e.g. `"Navigation.Web.HandlerTag"`) drives the
 * layer type, not the abstract bound's `any`.
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
 * Phantom-value sentinel — runtime `undefined`, used as a type carrier
 * for the `*Type` properties on each {@link Half}. Property type is
 * contextually inferred from the surrounding interface; the
 * `as never` cast lets the bottom-typed sentinel satisfy any property
 * type. Calling or accessing properties on this value crashes — it is
 * not data, only a type handle.
 */
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const PHANTOM = undefined as never

/**
 * Declare a typed cross-process message bridge.
 *
 * Each `Bridge.make(...)` call:
 *
 * 1. Builds two precise schema records from the `hostToWeb` /
 *    `webToHost` pair tuples (each entry's tag literal becomes a
 *    record key).
 * 2. Mints two fresh `Context.Tag` instances — one per side — via
 *    `Context.GenericTag`. Runtime identities are unique per call.
 * 3. Returns a {@link Bridge} whose `Host` and `Web` halves expose
 *    the schemas, the tag, a `ReceiverLayer` factory, a typed `send`
 *    function, the options shape, and phantom-typed handles for
 *    indexing types.
 *
 * Pair tuples are validated at the type level via
 * {@link Message.ValidatedPairs} — a mismatched `[tag, schema]` is a
 * compile error at the call site.
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
      // The runtime record carries `StringEncodedSchema` values; the
      // precise `RecordFromPairs<...>` type is recovered through the
      // generic instantiation. Necessary because `recordFromPairs`
      // has no per-pair type info to thread through.
      OutboundSchemas: hostToWebRecord,
      InboundSchemas: webToHostRecord,
      HandlerTag: HostHandlerTag,
      ReceiverLayer: (handlers) => Layer.succeed(HostHandlerTag, handlers),
      send: (message) =>
        // `message` is contextually typed as
        // `Message.Of<RecordFromPairs<HostToWebPairs>>` — abstract
        // inside the body, so TS cannot reduce it to a `_tag`-bearing
        // shape. Runtime invariant: every value is a tagged struct.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        sendThrough(hostToWebRecord, message as { readonly _tag: string }),
      OptionsShape: definition.hostOptionsShape,
      HandlerType: PHANTOM,
      SendableMessageType: PHANTOM,
      SenderType: PHANTOM,
      OptionsType: PHANTOM,
    },
    Web: {
      OutboundSchemas: webToHostRecord,
      InboundSchemas: hostToWebRecord,
      HandlerTag: WebHandlerTag,
      ReceiverLayer: (handlers) => Layer.succeed(WebHandlerTag, handlers),
      send: (message) =>
        // Same rationale as the Host side — see comment there.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        sendThrough(webToHostRecord, message as { readonly _tag: string }),
      OptionsShape: definition.webOptionsShape,
      HandlerType: PHANTOM,
      SendableMessageType: PHANTOM,
      SenderType: PHANTOM,
      OptionsType: PHANTOM,
    },
    MessageSchemas: {
      ...hostToWebRecord,
      ...webToHostRecord,
    },
  }
}

/**
 * Build a runtime `{[tag]: schema}` map from a pair tuple. Each pair's
 * second element is the precise schema; the helper's signature uses
 * {@link Message.StringEncodedSchema} because the body has no per-pair
 * type info to thread through. Caller's precise types survive via the
 * `RecordFromPairs<...>` cast in {@link make}'s return.
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
 * Encode a typed message via its tag's outbound schema and forward
 * the resulting string through the {@link PlatformAdapter} the
 * caller's Effect context provides. Unknown tags warn and drop — a
 * sender call for a tag the bridge doesn't declare indicates a wiring
 * mistake.
 *
 * The `PlatformAdapter` requirement on the return type is what lets
 * aggregators swap a live byte sink for a capturing test stub
 * without changing the call site: the requirement is satisfied
 * wherever a `Layer.succeed(PlatformAdapter, ...)` is in scope.
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

export { make }
export type {
  AnyBridge,
  AnyHalf,
  Bridge,
  Half,
  SendableMessage,
  SenderFn,
  SenderIntersection,
  TransportLayers,
}
