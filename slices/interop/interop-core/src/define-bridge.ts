import { Context, Effect, Layer, Schema } from 'effect'

/**
 * Typed cross-process message bridge — the slice-paired primitive that
 * binds a slice's outbound senders to its inbound receivers at the type
 * level. A bridge declares both directions in one place; transports
 * compose multiple bridges to produce a single typed `sendMessage` and a
 * merged Effect Context of receiver layers.
 *
 * The companion docs in `slices/interop/docs/Reference.md` cover the
 * runtime invariants (single-listener-per-tag, post-dispose warn-drop,
 * etc.) — those live in the transport implementations, not here.
 */

/**
 * Writes one encoded message string to the underlying transport. Effect
 * so platform implementations can fail (no host bridge present, etc.)
 * and so callers compose the send into larger Effect programs without
 * an `Effect.runSync` boundary at every site.
 */
type BareSender = (encoded: string) => Effect.Effect<void>

/**
 * Internal "JSON-encoded tagged schema" alias.
 *
 * Effect's `Schema.Schema<A, I, R>` is **invariant** in `A`, so a precise
 * `Schema<{readonly _tag: 'X'}, string>` is *not* assignable to
 * `Schema<unknown, string>`. Using `any` for `A` exempts this internal
 * bound from the variance check; the value is recovered at every public
 * boundary via `infer A` (a covariant extraction position) inside
 * {@link MessageOf}, {@link HandlersFor}, {@link SenderFn}, and the
 * conditional in {@link ValidatedPairs}.
 *
 * The `any` lives only inside this file. `RecordFromPairs<Pairs>`
 * preserves each pair's precise schema type at its key for any concrete
 * pair tuple, so user-visible types never widen to `any`.
 */
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type AnyJsonSchema = Schema.Schema<any, string, never>

/**
 * Schema describing the per-side options struct an aggregator passes when
 * wiring a bridge. Aliases Effect's {@link Schema.Schema.AnyNoContext}
 * (`Schema<any, any, never>`) — options aren't transmitted across the
 * WebView boundary, so the encoded form is unconstrained; consumers that
 * want runtime validation can decode through the bridge's `OptionsShape`,
 * but the bridge itself doesn't require it.
 */
type OptionsShape = Schema.Schema.AnyNoContext

/**
 * Per-pair validation. The conditional infers `Tag` from position 0 of
 * each pair, then checks the schema's *decoded* type (a covariant
 * extraction position) against `{readonly _tag: Tag}`. Matching pairs
 * pass through unchanged; mismatches resolve to a structured error tuple
 * so an invalid pair fails to satisfy the input shape and surfaces as a
 * TS error at the call site.
 *
 * Schema's invariance applies when matching `Schema<X, ...>` against
 * `Schema<Y, ...>` directly — the `infer A` form sidesteps that by
 * extracting `A` and testing it structurally.
 */
type ValidatedPairs<Pairs extends ReadonlyArray<readonly [string, AnyJsonSchema]>> = {
  readonly [I in keyof Pairs]: Pairs[I] extends readonly [infer Tag extends string, infer S]
    ? S extends Schema.Schema<infer A, string, never>
      ? A extends { readonly _tag: Tag }
        ? Pairs[I]
        : readonly [
            'ERROR: schema decodes to a value whose _tag does not match the declared tag',
            Tag,
            A,
          ]
      : readonly ['ERROR: not a Schema with string-encoded JSON form', Tag, S]
    : never
}

/**
 * Build a `{[tag]: schema}` record type from a tuple of `[tag, schema]`
 * pairs, preserving each schema's precise type at its key. The mapped
 * type distributes over the tuple's element union, so a tuple typed
 * `readonly [readonly ['Foo', typeof FooSchema], readonly ['Bar', typeof BarSchema]]`
 * becomes `{readonly Foo: typeof FooSchema; readonly Bar: typeof BarSchema}`.
 */
type RecordFromPairs<Pairs extends ReadonlyArray<readonly [string, AnyJsonSchema]>> = {
  readonly [P in Pairs[number] as P[0]]: P[1]
}

/** Internal value-type bound for "record of JSON-encoded tagged schemas". */
type AnyMessageSchemaRecord = Readonly<Record<string, AnyJsonSchema>>

/** Decoded message union for one side of a bridge. */
type MessageOf<R extends AnyMessageSchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never> ? A : never
}[keyof R]

/**
 * Per-tag handler record. Each callback receives the decoded message for
 * its tag and returns an Effect — context (logger, services) flows
 * through naturally without `Effect.runSync` boundaries. Sync side
 * effects wrap with `Effect.sync(() => ...)`; trivial no-ops can return
 * `Effect.void`.
 */
type HandlersFor<R extends AnyMessageSchemaRecord> = {
  readonly [Tag in keyof R]: R[Tag] extends Schema.Schema<infer A, string, never>
    ? (message: A) => Effect.Effect<void>
    : never
}

/**
 * Typed sender for one side. Returns an Effect so callers compose into
 * larger programs without crossing the Effect/sync boundary. Aggregators
 * merge multiple bridges' senders via type intersection — TS treats
 * `((a: A) => Effect<void>) & ((b: B) => Effect<void>)` as an overloaded
 * function callable with either `A` or `B`.
 */
type SenderFn<R extends AnyMessageSchemaRecord> = (message: MessageOf<R>) => Effect.Effect<void>

/**
 * String-literal Identifier for a bridge half's `Context.Tag`. Two
 * `defineBridge({name: 'X', ...})` calls produce *type-equivalent*
 * `HandlerTag`s (same Identifier + Service shapes) but *runtime-distinct*
 * tag instances (each `Context.GenericTag(...)` call mints a fresh
 * instance). This is intentional: TypeScript can't mint fresh nominal
 * types from value calls, so the type system can't catch accidental
 * name collisions; the runtime, however, never confuses two distinct
 * bridges. Same trade-off `Context.Tag` makes elsewhere in this repo.
 */
type HandlerTagId<
  BridgeName extends string,
  Side extends 'Native' | 'Web',
> = `${BridgeName}.${Side}.HandlerTag`

/** One side of a bridge. `Outbound` is what this side sends; `Inbound` is what it receives. */
interface BridgeHalf<
  BridgeName extends string,
  Side extends 'Native' | 'Web',
  Outbound extends AnyMessageSchemaRecord,
  Inbound extends AnyMessageSchemaRecord,
  Options extends OptionsShape,
> {
  readonly OutboundSchemas: Outbound
  readonly InboundSchemas: Inbound

  /** Fresh-per-call `Context.Tag` for this side's typed handler record. */
  readonly HandlerTag: Context.Tag<HandlerTagId<BridgeName, Side>, HandlersFor<Inbound>>

  /** Build a `Layer` that supplies `HandlerTag` with the caller's handlers. */
  readonly ReceiverLayer: (
    handlers: HandlersFor<Inbound>
  ) => Layer.Layer<HandlerTagId<BridgeName, Side>>

  /**
   * Wrap a {@link BareSender} with this side's outbound schemas, producing
   * a typed `(message) => void`. Aggregators call once per bridge and
   * merge the returned senders via type intersection.
   */
  readonly makeSender: (bareSender: BareSender) => SenderFn<Outbound>

  /** Schema describing the options the aggregator on this side expects when wiring this bridge. */
  readonly OptionsShape: Options

  /**
   * Phantom values — runtime `undefined`, typed for indexing with
   * `typeof Bridge.Native.SenderType` etc. Calling them or treating
   * them as data crashes; they exist only to surface types without an
   * intermediate `Schema.Schema.Type<...>` indirection. Confined to
   * this file; not used as a generic escape hatch.
   */
  readonly HandlerType: HandlersFor<Inbound>
  readonly SendableMessageType: MessageOf<Outbound>
  readonly SenderType: SenderFn<Outbound>
  readonly OptionsType: Schema.Schema.Type<Options>
}

/** A bridge's two halves plus its name. */
interface BridgeDefinition<
  BridgeName extends string,
  NativeToWeb extends AnyMessageSchemaRecord,
  WebToNative extends AnyMessageSchemaRecord,
  NativeOptions extends OptionsShape,
  WebOptions extends OptionsShape,
> {
  readonly name: BridgeName
  readonly Native: BridgeHalf<BridgeName, 'Native', NativeToWeb, WebToNative, NativeOptions>
  readonly Web: BridgeHalf<BridgeName, 'Web', WebToNative, NativeToWeb, WebOptions>
}

/**
 * Phantom-value sentinel — runtime `undefined`, used as a type carrier
 * for the `*Type` properties on each {@link BridgeHalf}. Property type
 * is contextually inferred from the surrounding interface; the
 * `as never` cast lets the bottom-typed sentinel satisfy any property
 * type. Calling or accessing properties on this value crashes — it is
 * not data, only a type handle.
 */
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const PHANTOM = undefined as never

/**
 * Declare a typed cross-process message bridge.
 *
 * Each `defineBridge(...)` call:
 *
 * 1. Builds two precise schema records from the `nativeToWeb` / `webToNative`
 *    pair tuples (each entry's tag literal becomes a record key).
 * 2. Mints two fresh `Context.Tag` instances — one per side — via
 *    `Context.GenericTag`. Runtime identities are unique per call.
 * 3. Returns a `BridgeDefinition` whose `Native` and `Web` halves expose
 *    the schemas, the tag, a `ReceiverLayer` factory, a typed `makeSender`,
 *    the options shape, and phantom-typed handles for indexing types.
 *
 * Pair tuples are validated at the type level via {@link ValidatedPairs}
 * — a mismatched `[tag, schema]` is a compile error at the call site.
 *
 * @example
 * ```ts
 * const NavigationBridge = defineBridge({
 *   name: 'Navigation',
 *   nativeToWeb: [['NativeBackRequested', NativeBackRequested]] as const,
 *   webToNative: [['RouteChanged', RouteChanged]] as const,
 *   nativeOptionsShape: Schema.Struct({ initialPath: Schema.String }),
 *   webOptionsShape: Schema.Struct({}),
 * })
 * ```
 */
const defineBridge = <
  const BridgeName extends string,
  const NativeToWebPairs extends ReadonlyArray<readonly [string, AnyJsonSchema]>,
  const WebToNativePairs extends ReadonlyArray<readonly [string, AnyJsonSchema]>,
  NativeOptions extends OptionsShape,
  WebOptions extends OptionsShape,
>(definition: {
  readonly name: BridgeName
  readonly nativeToWeb: NativeToWebPairs & ValidatedPairs<NativeToWebPairs>
  readonly webToNative: WebToNativePairs & ValidatedPairs<WebToNativePairs>
  readonly nativeOptionsShape: NativeOptions
  readonly webOptionsShape: WebOptions
}): BridgeDefinition<
  BridgeName,
  RecordFromPairs<NativeToWebPairs>,
  RecordFromPairs<WebToNativePairs>,
  NativeOptions,
  WebOptions
> => {
  const nativeToWebRecord = recordFromPairs<NativeToWebPairs>(definition.nativeToWeb)
  const webToNativeRecord = recordFromPairs<WebToNativePairs>(definition.webToNative)

  const NativeHandlerTag = Context.GenericTag<
    HandlerTagId<BridgeName, 'Native'>,
    HandlersFor<RecordFromPairs<WebToNativePairs>>
  >(`${definition.name}.Native.HandlerTag`)

  const WebHandlerTag = Context.GenericTag<
    HandlerTagId<BridgeName, 'Web'>,
    HandlersFor<RecordFromPairs<NativeToWebPairs>>
  >(`${definition.name}.Web.HandlerTag`)

  return {
    name: definition.name,
    Native: {
      // The runtime record carries `AnyJsonSchema` values; the precise
      // `RecordFromPairs<...>` type is recovered here. Necessary because
      // the `recordFromPairs` helper has no per-pair type info to thread
      // through; the boundary cast is the only place precision returns.
      OutboundSchemas: nativeToWebRecord,
      InboundSchemas: webToNativeRecord,
      HandlerTag: NativeHandlerTag,
      ReceiverLayer: (handlers) => Layer.succeed(NativeHandlerTag, handlers),
      makeSender: (bareSender) => (message) =>
        // `message` is contextually typed as
        // `MessageOf<RecordFromPairs<NativeToWebPairs>>` — abstract
        // inside the body, so TS cannot reduce it to a `_tag`-bearing
        // shape. Runtime invariant: every value is a tagged struct.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        sendThrough(nativeToWebRecord, bareSender, message as { readonly _tag: string }),
      OptionsShape: definition.nativeOptionsShape,
      HandlerType: PHANTOM,
      SendableMessageType: PHANTOM,
      SenderType: PHANTOM,
      OptionsType: PHANTOM,
    },
    Web: {
      OutboundSchemas: webToNativeRecord,
      InboundSchemas: nativeToWebRecord,
      HandlerTag: WebHandlerTag,
      ReceiverLayer: (handlers) => Layer.succeed(WebHandlerTag, handlers),
      makeSender: (bareSender) => (message) =>
        // Same rationale as the Native side — see comment there.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        sendThrough(webToNativeRecord, bareSender, message as { readonly _tag: string }),
      OptionsShape: definition.webOptionsShape,
      HandlerType: PHANTOM,
      SendableMessageType: PHANTOM,
      SenderType: PHANTOM,
      OptionsType: PHANTOM,
    },
  }
}

/**
 * Build a runtime `{[tag]: schema}` map from a pair tuple. Each pair's
 * second element is the precise schema; the helper's signature uses
 * {@link AnyJsonSchema} because the body has no per-pair type info to
 * thread through. Caller's precise types survive via the
 * `RecordFromPairs<...>` cast in {@link defineBridge}'s return.
 */
const recordFromPairs = <TPairs extends ReadonlyArray<readonly [string, AnyJsonSchema]>>(
  pairs: TPairs
): RecordFromPairs<TPairs> => {
  const record: Record<string, AnyJsonSchema> = {}
  for (const [tag, schema] of pairs) record[tag] = schema
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return record as RecordFromPairs<TPairs>
}

/**
 * Encode a typed message via its tag's outbound schema and forward the
 * resulting string to the bare transport. Unknown tags warn and drop —
 * a sender call for a tag the bridge doesn't declare indicates a wiring
 * mistake. Returns an Effect so logging and the bare-sender call run in
 * the caller's Effect context (logger, services, etc.).
 */
const sendThrough = (
  record: Record<string, AnyJsonSchema>,
  bareSender: BareSender,
  message: { readonly _tag: string }
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const schema = record[message._tag]
    if (schema === undefined) {
      yield* Effect.logWarning(
        `[interop] sendMessage: no outbound schema for "${message._tag}"; dropping`
      )
      return undefined
    }
    yield* bareSender(Schema.encodeSync(schema)(message))
    return undefined
  })

export { defineBridge }
export type {
  BareSender,
  BridgeDefinition,
  BridgeHalf,
  HandlersFor,
  HandlerTagId,
  MessageOf,
  OptionsShape,
  RecordFromPairs,
  AnyMessageSchemaRecord as SchemaRecord,
  SenderFn,
  ValidatedPairs,
}
