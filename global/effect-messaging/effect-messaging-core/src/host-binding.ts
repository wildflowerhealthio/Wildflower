import { type Context, Effect, type Layer } from 'effect'
import type * as Bridge from './bridge.ts'

/**
 * Host-side tag identifier for a bridge — `${B['name']}.Host.HandlerTag`,
 * extracted via `Context.Tag`'s structural slot so it resolves even when
 * `B['name']` widens to `string` under {@link Bridge.AnyBridge}.
 */
type HostHandlerTagId<B extends Bridge.AnyBridge> = Context.Tag.Identifier<B['Host']['HandlerTag']>

/**
 * Erased-bridge sender exposed to {@link HostBinding.onTransportReady}.
 *
 * @remarks
 * The transport's `sendMessage` is a function-intersection across every
 * wired bridge's typed sender — contravariant in `Bridges`. The widened
 * single-signature shape here lets a tuple of narrowly-typed bindings
 * structurally unify with {@link Any} and lets slices pass typed
 * message literals (`{ _tag, token, … }`) without tripping the
 * excess-property check.
 */
type BindingSend = (message: {
  readonly _tag: string
  readonly [key: string]: unknown
}) => Effect.Effect<void>

/**
 * Uniform host-side wiring contract for one bridge. Each slice's
 * `use<Slice>HostBinding` hook returns one of these; a host shell
 * aggregates a tuple via {@link aggregate}.
 *
 * See [Host Bindings Explanation](../../../../docs/Effect/Host%20Bindings%20Explanation.md).
 */
interface HostBinding<B extends Bridge.AnyBridge> {
  readonly bridge: B
  readonly receiverLayer: Layer.Layer<HostHandlerTagId<B>>
  readonly initialMessages?: ReadonlyArray<Bridge.UrlParamableMessage<readonly [B]>>
  readonly onTransportReady?: (send: BindingSend) => Effect.Effect<void>
}

/**
 * Structural bound for "any binding a shell can aggregate". Declared
 * structurally (not as `HostBinding<Bridge.AnyBridge>`) so a tuple of
 * narrowly-typed `HostBinding<X_i>` unifies — the parameterised form's
 * `bridge: B` position blocks the assignment otherwise.
 */
type Any = {
  readonly bridge: Bridge.AnyBridge
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly receiverLayer: Layer.Layer<any>
  readonly initialMessages?: ReadonlyArray<{
    readonly _tag: string
    readonly [key: string]: unknown
  }>
  readonly onTransportReady?: (send: BindingSend) => Effect.Effect<void>
}

/** Tuple-mapped bridges extracted from a tuple of bindings. */
type BridgesOf<Bindings extends ReadonlyArray<Any>> = {
  readonly [I in keyof Bindings]: Bindings[I]['bridge']
}

/** Tuple-mapped host receiver layers extracted from a tuple of bindings. */
type LayersOf<Bindings extends ReadonlyArray<Any>> = {
  readonly [I in keyof Bindings]: Bindings[I]['receiverLayer']
}

/** Union of decoded initial messages a binding tuple contributes. */
type InitialMessageOf<Bindings extends ReadonlyArray<Any>> = Bridge.UrlParamableMessage<
  BridgesOf<Bindings>
>

/**
 * Aggregate a binding tuple into the positional tuples
 * `BridgeTransport.make` requires plus the flattened initial-message
 * stream. The two narrow `as unknown as` casts here are the parallel-
 * tuple proof point — `Array.prototype.map` widens tuple positions to
 * `T[]`, so we re-narrow against the tuple-mapped type aliases.
 */
const aggregate = <const Bindings extends ReadonlyArray<Any>>(
  bindings: Bindings
): {
  readonly bridges: BridgesOf<Bindings>
  readonly layers: LayersOf<Bindings>
  readonly initialMessages: ReadonlyArray<InitialMessageOf<Bindings>>
} => ({
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  bridges: bindings.map((b) => b.bridge) as unknown as BridgesOf<Bindings>,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  layers: bindings.map((b) => b.receiverLayer) as unknown as LayersOf<Bindings>,
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  initialMessages: bindings.flatMap((b) => b.initialMessages ?? []) as unknown as ReadonlyArray<
    InitialMessageOf<Bindings>
  >,
})

/**
 * Fire every binding's `onTransportReady` with the (widened) transport
 * sender. Forks each effect — callers wrap this in a `useEffect` that
 * re-runs when the transport rebuilds. The caller widens
 * `transport.sendMessage` to {@link BindingSend} since the
 * function-intersection form doesn't cross the API boundary cleanly.
 */
const callTransportReady = (bindings: ReadonlyArray<Any>, send: BindingSend): void => {
  for (const binding of bindings) {
    if (binding.onTransportReady === undefined) continue
    Effect.runFork(binding.onTransportReady(send))
  }
}

export { aggregate, callTransportReady }
export type {
  Any,
  BindingSend,
  BridgesOf,
  HostBinding,
  HostHandlerTagId,
  InitialMessageOf,
  LayersOf,
}
