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
 * lives at the transport entry points, not in these types.
 */
type Direction = 'HostToWeb' | 'WebToHost'

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
}

/** Structural bound for "any wired bridge". */
type AnyBridge = {
  readonly name: string
  readonly HostToWeb: Message.SchemaRecord
  readonly WebToHost: Message.SchemaRecord
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
 *   breaking sender variance checks; the distributive conditional stays
 *   *deferred* over a generic `Bridges`, preserving the symbolic
 *   relationship that lets a full-tuple sender hand off to a narrower
 *   single-bridge sender.
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
 * })
 * ```
 *
 * @remarks
 * Pair tuples are validated via {@link Message.ValidatedPairs} — a
 * mismatched `[tag, schema]` fails at the call site.
 */
const make = <
  const Name extends string,
  const HostToWebPairs extends ReadonlyArray<readonly [string, Message.AnyStringEncodedSchema]>,
  const WebToHostPairs extends ReadonlyArray<readonly [string, Message.AnyStringEncodedSchema]>,
>(definition: {
  readonly name: Name
  readonly hostToWeb: HostToWebPairs & Message.ValidatedPairs<HostToWebPairs>
  readonly webToHost: WebToHostPairs & Message.ValidatedPairs<WebToHostPairs>
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
  }
}

export { make }
export type { AnyBridge, Bridge, Direction, HandlersByBridge, SendableMessage }
