import type { Schema } from 'effect'
import type * as MessageHandler from './message-handler.ts'
import * as Message from './message.ts'

/**
 * The two directional schema records a bridge carries. `'HostToWeb'` is
 * what the host sends and the web receives; `'WebToHost'` is the reverse.
 *
 * @remarks
 * This replaces the older endpoint-keyed `Side` (`'Host' | 'Web'`): a
 * `Direction` names the *wire flow* directly, so a transport (or handler
 * record) selects `bridge[direction]` without an endpoint→direction
 * translation step. The host's inbound direction is `'WebToHost'` and its
 * outbound is `'HostToWeb'`; the web side is the mirror — but that mapping
 * now lives at the two transport entry points, not in these types.
 */
type Direction = 'HostToWeb' | 'WebToHost'

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

/**
 * A declared cross-process bridge: the two directional schema records
 * plus its name. `HostToWeb` is what the host sends and the web receives;
 * `WebToHost` is the reverse.
 *
 * @remarks
 * A bridge knows only its schemas. Encoding a typed message to its wire
 * string is {@link Message.stringifyMessage}; putting that string on the
 * wire is the transport's job (`BridgeTransport`). The bridge itself is
 * unaware of any sending mechanics.
 */
interface Bridge<
  Name extends string,
  HostToWeb extends Message.SchemaRecord,
  WebToHost extends Message.SchemaRecord,
> {
  readonly name: Name
  readonly HostToWeb: HostToWeb
  readonly WebToHost: WebToHost
  readonly UrlParamSchemas: UrlParamSchemas<HostToWeb>
}

/** Structural bound for "any wired bridge". */
type AnyBridge = {
  readonly name: string
  readonly HostToWeb: Message.SchemaRecord
  readonly WebToHost: Message.SchemaRecord
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly UrlParamSchemas: Readonly<Record<string, Schema.Schema<any, string, never> | undefined>>
}

/**
 * Union of every decoded message a wired bridge sends in `Dir`.
 *
 * @remarks
 * Two nested conditionals, each load-bearing:
 *
 * - The inner `Bridges[number] extends infer B ? (B extends AnyBridge ? …)`
 *   distributes a naked `B` over each bridge member (the `infer B` is a
 *   distribution *binder*, not a decoded-type extraction) and yields
 *   `Message.Of<B[Dir]>` per bridge — extraction is delegated to
 *   {@link Message.Of}, so `SendableMessage` keeps no decoded-type `infer`.
 *   A naked distribution is required because indexing a tuple-mapped type
 *   (`{ [I in keyof Bridges]: … }[number]`) over a *generic* `Bridges`
 *   eagerly collapses `Bridges[number]` to its `AnyBridge` constraint,
 *   breaking the sender variance check in {@link callPageReady}; the
 *   distributive conditional stays *deferred* over a generic `Bridges`,
 *   preserving the symbolic relationship that lets the full-tuple sender
 *   hand off to each narrow per-slot callback.
 * - The outer `… extends infer M extends { readonly _tag: string } ? M`
 *   re-pins the constraint to `{ _tag: string }`. Without it the doubly
 *   deferred inner conditional has no apparent `_tag`, so the generic
 *   outbound pump's `message._tag` read in `bridge-transport.ts` fails to
 *   type-check. {@link Message.Of} applies the same re-pin internally, but
 *   the extra distribution layer hides it — so it is reapplied here.
 */
type SendableMessage<Bridges extends ReadonlyArray<AnyBridge>, Dir extends Direction> = (
  Bridges[number] extends infer B ? (B extends AnyBridge ? Message.Of<B[Dir]> : never) : never
) extends infer M extends { readonly _tag: string }
  ? M
  : never

/**
 * Union of decoded message types whose tags have a `urlParams` schema
 * declared on some wired bridge. The Expo transport's `initialMessages`
 * narrows to this so call sites can't pass a tag that has no URL form.
 *
 * @remarks
 * Maps over the `Bridges` tuple and, per bridge, strips its
 * `UrlParamSchemas` down to a plain `Message.SchemaRecord` — the `-?`
 * modifier removes the optional flag inherited from `UrlParamSchemas`'s
 * `?` keys and `NonNullable` drops the `| undefined` — then delegates the
 * decoded-type extraction to {@link Message.Of}. This keeps
 * `UrlParamableMessage` `infer`-free; the lone surviving extraction
 * `infer` lives in `Message.Of`.
 */
type UrlParamableMessage<Bridges extends ReadonlyArray<AnyBridge>> = {
  readonly [I in keyof Bridges]: Message.Of<{
    readonly [Tag in keyof Bridges[I]['UrlParamSchemas']]-?: NonNullable<
      Bridges[I]['UrlParamSchemas'][Tag]
    >
  }>
}[number]

/**
 * Tuple-mapped handler requirement for a bridge transport. Position `I`
 * carries `MessageHandler.HandlersFor` over position `I`'s schema record
 * for the inbound `Dir` — one Effect-returning function per inbound tag.
 *
 * @remarks
 * `Dir` here is the bridge's *inbound* direction for the receiving side:
 * a host receiver passes `'WebToHost'`, a web receiver `'HostToWeb'`. The
 * old `Side`-keyed `InboundHandlers<B, S>` indirection is gone — handler
 * records are now `HandlersFor<Bridges[I][Dir]>` directly.
 */
type HandlersByBridge<Bridges extends ReadonlyArray<AnyBridge>, Dir extends Direction> = {
  readonly [I in keyof Bridges]: MessageHandler.HandlersFor<Bridges[I][Dir]>
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
 * Pair tuples are validated via {@link Message.ValidatedPairs} — a
 * mismatched `[tag, schema]` fails at the call site. `urlParams` is
 * optional; tags without a urlParams schema can't ride on the WebView
 * source URL.
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

  return {
    name: definition.name,
    HostToWeb: hostToWebRecord,
    WebToHost: webToHostRecord,
    UrlParamSchemas: definition.urlParams ?? {},
  }
}

export { make }
export type {
  AnyBridge,
  Bridge,
  Direction,
  HandlersByBridge,
  SendableMessage,
  UrlParamableMessage,
  UrlParamSchemas,
}
