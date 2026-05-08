import type { Context, Layer, ParseResult } from 'effect'
import { Data, Effect, Schema } from 'effect'
import type { BareSender, SchemaRecord } from './define-bridge.ts'

/**
 * Cross-platform dispatch primitives shared by every concrete transport.
 *
 * Lives in `interop-core` because the type machinery, error vocabulary,
 * envelope schema, and error-to-log formatter are identical on the Web
 * (`window.postMessage`) and Expo (`react-native-webview`) sides — only
 * the platform glue (where bytes come from / go to, how listeners
 * attach, how initial messages are seeded) differs.
 *
 * What stays platform-specific (in `interop-react`, `interop-expo`):
 *
 * - The `BareSender` body — `window.ReactNativeWebView.postMessage` vs
 *   a `WebView` ref's `postMessage`.
 * - The inbound subscription — `window.addEventListener('message')` vs
 *   the `<WebView onMessage={...}>` prop.
 * - Initial-message handling — the Web side *drains* a pre-injected
 *   `window.__INITIAL_MESSAGES__`; the Expo side *produces* the
 *   `injectedJavaScriptBeforeContentLoaded` string that defines that
 *   global on the page.
 * - Disposal mechanics.
 */

/**
 * Structural bound for "any bridge a transport can drive". Concrete
 * `BridgeDefinition<...>` from `define-bridge.ts` fits via structural
 * typing — extra fields (`HandlerType`, `SenderType`, etc.) are
 * ignored.
 *
 * Why structural and not `BridgeDefinition<string, ...>`: that interface
 * is invariant in its schema/options generics (Outbound and Inbound each
 * appear in covariant and contravariant positions across the two
 * halves), so concrete bridges aren't assignable to a parameterised
 * abstract form. `Context.Tag<any, any>` here uses `Tag`'s own variance
 * escape — `Tag` is invariant in both `Id` and `Service`, so `any` is
 * the only way to admit a concrete tag through this bound.
 *
 * Both halves are declared because every concrete bridge has both;
 * which side a transport drives is a separate `Side` type parameter on
 * the helpers below, not a property of the bridge type.
 */
type AnyBridgeHalf = {
  readonly InboundSchemas: SchemaRecord
  readonly OutboundSchemas: SchemaRecord
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly HandlerTag: Context.Tag<any, any>
  // The argument type is `never` so concrete senders — including
  // `(m: SpecificUnion) => Effect<void>` (concrete outbound) and
  // `(m: never) => Effect<void>` (empty outbound) — both fit under
  // function-parameter contravariance. Precise sender types are
  // recovered at type-derivation sites via `infer`.
  readonly makeSender: (bareSender: BareSender) => (m: never) => Effect.Effect<void>
}

type AnyBridge = {
  readonly name: string
  readonly Native: AnyBridgeHalf
  readonly Web: AnyBridgeHalf
}

/**
 * Standard union-to-intersection trick. A union in a contravariant
 * position (function argument) inverts to an intersection during
 * inference. Used to merge multiple bridges' senders into a single
 * overloaded function callable with any wired bridge's outbound message.
 */
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never

/**
 * Function-intersection of every wired bridge's typed sender for the
 * specified side. Extracted from the concrete bridges via `infer` so the
 * precise per-bridge outbound types survive the structural `AnyBridge`
 * bound — type-level access narrows back to the concrete sender at the
 * call site.
 */
type BridgeSenderIntersection<
  Bridges extends ReadonlyArray<AnyBridge>,
  Side extends 'Native' | 'Web',
> = UnionToIntersection<
  Bridges[number] extends infer B
    ? B extends { readonly [K in Side]: { readonly makeSender: (s: BareSender) => infer F } }
      ? F
      : never
    : never
>

/**
 * Union of every decoded message a wired bridge's `Side` can send. Used
 * by transports that need a typed input list — e.g. the Expo
 * transport's `initialMessages: ReadonlyArray<BridgeSendableMessage<Bridges, 'Native'>>`
 * — where `BridgeSenderIntersection`'s function-intersection shape is
 * the wrong tool (intersected functions don't yield their parameter
 * union via `Parameters`, since TS treats the intersection as
 * overloads).
 */
type BridgeSendableMessage<
  Bridges extends ReadonlyArray<AnyBridge>,
  Side extends 'Native' | 'Web',
> = Bridges[number] extends infer B
  ? B extends {
      readonly [K in Side]: {
        readonly makeSender: (s: BareSender) => (
          // The `infer M extends ...` form pins the inferred type to the
          // bridge invariant: every wired message has a string `_tag`.
          // Without the constraint, callers that loop over the union
          // can't access `_tag` without a cast.
          m: infer M extends { readonly _tag: string }
        ) => Effect.Effect<void>
      }
    }
    ? M
    : never
  : never

/**
 * Tuple-mapped layers requirement. Position I must supply position I's
 * bridge tag (for the specified side); mismatched lengths or tag
 * identifiers fail at the call site. The `Id` is `infer`-extracted from
 * the concrete bridge so the precise tag identifier (e.g.
 * `"Navigation.Web.HandlerTag"`) drives the layer type, not the
 * abstract bound's `any`.
 */
type BridgeTransportLayers<
  Bridges extends ReadonlyArray<AnyBridge>,
  Side extends 'Native' | 'Web',
> = {
  readonly [I in keyof Bridges]: Bridges[I] extends {
    // oxlint-disable-next-line typescript/no-explicit-any
    readonly [K in Side]: { readonly HandlerTag: Context.Tag<infer Id, any> }
  }
    ? Layer.Layer<Id>
    : never
}

/**
 * Source channel an inbound message arrived through. Used in log
 * messages to distinguish initial-message replay (Web's
 * `__INITIAL_MESSAGES__` drain, Expo's not-applicable) from live
 * traffic.
 */
type DispatchSource = 'live' | 'initial'

/**
 * Three-bucket failure surface for inbound dispatch.
 *
 * - {@link ParseResult.ParseError}: anything Schema rejects — at the
 *   envelope (`{_tag: string}`) layer or at the per-bridge specific
 *   decode. Reuses Effect's built-in error rather than wrapping; the
 *   formatter handles the rendering.
 * - {@link UnknownTag}: envelope decoded fine, but the resulting `_tag`
 *   isn't owned by any wired bridge. Distinguished from `ParseError` so
 *   callers can tell "we don't recognise this tag" from "this tag is
 *   ours but the payload is malformed".
 * - {@link DisposedReceived}: a message arrived after the transport
 *   was disposed. Rare; points at a lifecycle bug.
 */
class UnknownTag extends Data.TaggedError('UnknownTag')<{
  readonly source: DispatchSource
  readonly tag: string
}> {}
class DisposedReceived extends Data.TaggedError('DisposedReceived')<{
  readonly source: DispatchSource
}> {}

type DispatchError = ParseResult.ParseError | UnknownTag | DisposedReceived

/**
 * Envelope schema: anything routable across the bridge has a string
 * `_tag`. Transports decode against this first to extract the tag for
 * the unknown-tag check, then per-bridge schemas validate the full
 * payload. The two-pass approach lets the transport return a structured
 * `UnknownTag` for unowned tags while still surfacing payload-shape
 * failures as `ParseError`.
 */
const envelopeSchema = Schema.parseJson(Schema.Struct({ _tag: Schema.String }))

/**
 * Map a structured {@link DispatchError} to a single `Effect.logWarning`
 * call. Transports use this in `Effect.catchAll(errorToLog)` so every
 * dispatch failure surfaces through the same channel; callers that want
 * different behaviour (e.g. a structured telemetry emit instead of a
 * log) can substitute their own catch.
 */
const errorToLog = (error: DispatchError): Effect.Effect<void> => {
  if (error._tag === 'UnknownTag') {
    return Effect.logWarning(`[interop] unknown ${error.source} message tag: "${error.tag}"`)
  }
  if (error._tag === 'DisposedReceived') {
    return Effect.logWarning(`[interop] received ${error.source} message after dispose; dropping`)
  }
  // ParseError: anything Schema rejected. `String(parseError)` gives a
  // structured tree-formatted message; sufficient for a single log line.
  return Effect.logWarning(`[interop] failed to decode message: ${String(error)}`)
}

export { DisposedReceived, envelopeSchema, errorToLog, UnknownTag }
export type {
  AnyBridge,
  AnyBridgeHalf,
  BridgeSendableMessage,
  BridgeSenderIntersection,
  BridgeTransportLayers,
  DispatchError,
  DispatchSource,
  UnionToIntersection,
}
