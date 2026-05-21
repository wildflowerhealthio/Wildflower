import type { Context, Effect, Layer } from 'effect'
import type * as Bridge from './bridge.ts'

/**
 * Host-side tag identifier for a bridge. Pulled off the bridge's
 * `Host.HandlerTag` so the binding's `receiverLayer` only needs
 * `Layer<HostHandlerTagId<B>>` regardless of how the bridge was
 * defined. Equivalent to `MessageHandler.TagId<B['name'], 'Host'>` but
 * resolves correctly even when `B['name']` is widened to `string` by
 * the {@link Bridge.AnyBridge} structural bound.
 */
type HostHandlerTagId<B extends Bridge.AnyBridge> = Context.Tag.Identifier<B['Host']['HandlerTag']>

/**
 * Erased-bridge sender exposed to {@link SliceHostBinding.onTransportReady}.
 *
 * @remarks
 * The shell's transport carries a function-intersection over every
 * wired bridge's typed sender — which is contravariant in `Bridges`,
 * preventing a tuple of narrowly-typed `SliceHostBinding<X_i>` from
 * unifying with `ReadonlyArray<SliceHostBinding<AnyBridge>>`. The
 * binding's `onTransportReady` therefore takes the same widened
 * single-signature shape the React host-messaging context exposes —
 * the slice constructs a narrowly-typed message inline and lets the
 * runtime dispatch by `_tag`. The index signature lets call sites
 * pass typed message literals (`{ _tag, token, … }`) without tripping
 * the excess-property check.
 */
type BindingSend = (message: {
  readonly _tag: string
  readonly [key: string]: unknown
}) => Effect.Effect<void>

/**
 * Uniform host-side wiring contract for one bridge. Slice platform
 * packages (e.g. `apps-expo`, `gatekeeper-expo`) expose a
 * `use<Slice>HostBinding` hook returning this; a host shell aggregates
 * an array of bindings into the transport's bridges + layers + initial
 * messages tuples plus a post-mount effect run.
 *
 * @remarks
 * `bridge` and `receiverLayer` are paired by construction so a tuple
 * of bindings can't accidentally pair a `Foo` bridge with a `Bar`
 * receiver layer the way two parallel positional tuples can.
 *
 * `initialMessages` ride the platform's URL-param channel — see
 * {@link Bridge.UrlParamableMessage} for the eligibility constraint
 * (tags whose owning bridge declared a `urlParams` schema).
 *
 * `onTransportReady` runs once the transport is built, before any
 * external dispatch — slices use it to seed late-bound state (auth
 * tokens, hello packets) without putting the payload on the
 * URL-param channel.
 */
interface SliceHostBinding<B extends Bridge.AnyBridge> {
  readonly bridge: B
  readonly receiverLayer: Layer.Layer<HostHandlerTagId<B>>
  readonly initialMessages?: ReadonlyArray<Bridge.UrlParamableMessage<readonly [B]>>
  readonly onTransportReady?: (send: BindingSend) => Effect.Effect<void>
}

/**
 * Structural bound for "any host binding a shell can aggregate". The
 * shell consumes bindings without caring about each bridge's concrete
 * shape; the narrow `SliceHostBinding<B>` constraint surfaces at the
 * slice's hook return type.
 *
 * @remarks
 * Declared as the structural shape rather than `SliceHostBinding<Bridge.AnyBridge>`
 * because the parameterised form is invariant under TypeScript's structural
 * subtyping when nested under `ReadonlyArray<…>`: a tuple of narrowly-typed
 * `SliceHostBinding<X_i>` doesn't unify with it. The structural form below
 * uses Layer.Layer's covariant `out` position and the widened sender
 * signature, so a binding tuple flows through without per-slot casts.
 */
type AnyHostBinding = {
  readonly bridge: Bridge.AnyBridge
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly receiverLayer: Layer.Layer<any>
  readonly initialMessages?: ReadonlyArray<{
    readonly _tag: string
    readonly [key: string]: unknown
  }>
  readonly onTransportReady?: (send: BindingSend) => Effect.Effect<void>
}

/**
 * Tuple-mapped bridges extracted from a tuple of bindings. Pairs with
 * {@link ReceiverLayersFromBindings} so a shell can derive the two
 * positional tuples `BridgeTransport.make` requires from one ordered
 * list of bindings — no risk of a `Foo`-layer landing in the `Bar`
 * slot.
 */
type BridgesFromBindings<Bindings extends ReadonlyArray<AnyHostBinding>> = {
  readonly [I in keyof Bindings]: Bindings[I]['bridge']
}

/**
 * Tuple-mapped host-side receiver layers extracted from a tuple of
 * bindings. Pairs with {@link BridgesFromBindings}.
 */
type ReceiverLayersFromBindings<Bindings extends ReadonlyArray<AnyHostBinding>> = {
  readonly [I in keyof Bindings]: Bindings[I]['receiverLayer']
}

/**
 * Union of decoded messages whose tags have a `urlParams` schema on
 * one of the binding tuple's bridges. Mirrors
 * {@link Bridge.UrlParamableMessage} but indexed off a binding tuple
 * for shell convenience.
 */
type CombinedInitialMessage<Bindings extends ReadonlyArray<AnyHostBinding>> =
  Bridge.UrlParamableMessage<BridgesFromBindings<Bindings>>

export type {
  AnyHostBinding,
  BindingSend,
  BridgesFromBindings,
  CombinedInitialMessage,
  HostHandlerTagId,
  ReceiverLayersFromBindings,
  SliceHostBinding,
}
