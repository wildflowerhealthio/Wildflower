import { Effect, type Context, type Layer } from 'effect'
import { flattenTuples } from 'kitchen-sink/types'
import type * as BridgeTransport from './bridge-transport.ts'
import type * as Bridge from './bridge.ts'

/**
 * Host-side tag identifier for a bridge — `${B['name']}.Host.HandlerTag`,
 * extracted via `Context.Tag`'s structural slot so it resolves even when
 * `B['name']` widens to `string` under {@link Bridge.AnyBridge}.
 */
type HostHandlerTagId<B extends Bridge.AnyBridge> = Context.Tag.Identifier<B['Host']['HandlerTag']>

/**
 * Per-bridge initial messages, parallel-indexed against the surrounding
 * `Bridges` tuple. Slot `I` carries every {@link Bridge.UrlParamableMessage}
 * the host wants to seed for `Bridges[I]` (zero or many).
 */
type InitialMessagesByBridge<Bridges extends ReadonlyArray<Bridge.AnyBridge>> = {
  readonly [I in keyof Bridges]: ReadonlyArray<Bridge.UrlParamableMessage<readonly [Bridges[I]]>>
}

/**
 * Per-bridge `onTransportReady` callbacks, parallel-indexed against the
 * surrounding `Bridges` tuple. Slot `I` is either undefined (no
 * post-mount work) or a callback whose sender is narrowly typed to
 * `Bridges[I]`.
 */
type OnTransportReadyByBridge<Bridges extends ReadonlyArray<Bridge.AnyBridge>> = {
  readonly [I in keyof Bridges]:
    | ((send: BridgeTransport.MessageSender<readonly [Bridges[I]], 'Host'>) => Effect.Effect<void>)
    | undefined
}

/**
 * Uniform host-side wiring contract. Four parallel-indexed arrays:
 *
 * - `bridges[i]` is the bridge declaration.
 * - `receiverLayers[i]` discharges `bridges[i]`'s Host handler tag.
 * - `initialMessages[i]` are URL-param-seeded payloads for `bridges[i]`
 *   (zero or many).
 * - `onTransportReady[i]` runs once the transport is built, with the
 *   typed sender for `bridges[i]` (or `undefined` for slices that don't
 *   need post-mount work).
 *
 * Compose multiple slices via {@link combine}: the four arrays
 * concatenate index-aligned, so the result satisfies the same
 * parallel-tuple shape `BridgeTransport.make` consumes. Single-bridge
 * slices construct theirs via {@link single}.
 *
 * See [Host Bindings Explanation](../docs/Host%20Bindings%20Explanation.md).
 */
interface HostBindings<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly bridges: Bridges
  readonly receiverLayers: Bridge.TransportLayers<Bridges, 'Host'>
  readonly initialMessages: InitialMessagesByBridge<Bridges>
  readonly onTransportReady: OnTransportReadyByBridge<Bridges>
}

/**
 * Construct a {@link HostBindings} for a single bridge from the
 * traditional one-object-per-slice shape. Wraps each field in a 1-tuple
 * so it composes with other slices via {@link combine}.
 *
 * @example
 * ```ts
 * const bindings = HostBindings.single({
 *   bridge: GatekeeperBridge,
 *   receiverLayer: GatekeeperBridge.Host.ReceiverLayer({}),
 *   initialMessages: [{ _tag: 'WaitForToken' }],
 *   onTransportReady: token === undefined
 *     ? undefined
 *     : (send) => send({ _tag: 'AuthTokenIssued', token }),
 * })
 * ```
 */
const single = <const B extends Bridge.AnyBridge>(binding: {
  readonly bridge: B
  readonly receiverLayer: Layer.Layer<HostHandlerTagId<B>>
  readonly initialMessages?: ReadonlyArray<Bridge.UrlParamableMessage<readonly [B]>>
  readonly onTransportReady?: (
    send: BridgeTransport.MessageSender<readonly [B], 'Host'>
  ) => Effect.Effect<void>
}): HostBindings<readonly [B]> => ({
  bridges: [binding.bridge] as const,
  // The mapped-tuple TransportLayers<readonly [B], 'Host'> doesn't
  // structurally reduce against `[Layer<HostHandlerTagId<B>>]` because
  // its conditional `B extends { Host: { HandlerTag: Tag<infer Id> } }`
  // doesn't fire on the structural `Bridge.AnyBridge` bound. The
  // assertion is sound: the layer was declared against the same
  // handler tag the mapped type extracts.
  receiverLayers: [binding.receiverLayer],
  initialMessages: [binding.initialMessages ?? []] as const,
  onTransportReady: [binding.onTransportReady] as const,
})

/**
 * Type-level flat-concat over a tuple of `HostBindings`. Recursively
 * peels one element off the head and prepends its `Bridges` tuple to
 * the recursive tail.
 */
type CombineHostBindings<T extends ReadonlyArray<HostBindings<ReadonlyArray<Bridge.AnyBridge>>>> =
  HostBindings<
    flattenTuples<{
      readonly [I in keyof T]: T[I]['bridges']
    }>
  >

/**
 * Concatenate a tuple of {@link HostBindings} into a single bindings
 * struct. Each of the four parallel arrays concatenates in the same
 * order the inputs are passed, so the result preserves the
 * parallel-tuple invariant `BridgeTransport.make` and {@link callTransportReady}
 * consume.
 *
 * @example
 * ```ts
 * const merged = HostBindings.combine([
 *   navigationBindings,
 *   gatekeeperBindings,
 *   collectorBindings,
 *   appsBindings,
 *   logBindings,
 * ])
 * ```
 *
 * @remarks
 * The four `as unknown as` casts re-narrow `Array.prototype.flatMap`
 * results to the tuple-mapped types — TS widens the result of `flatMap`
 * over a tuple-of-tuples to `T[]`, which the mapped-tuple shape
 * doesn't unify with.
 *
 * Takes a single tuple parameter rather than rest (`...bindings`)
 * because `babel-preset-expo` transpiles rest params to `new Array(_len)`,
 * and `bridge.ts` / `bridge-transport.ts` import the Effect `Array`
 * module at the top of the bundled dist — which shadows the global
 * `Array` constructor and crashes at runtime.
 */
// const T extends ReadonlyArray<HostBindings<ReadonlyArray<Bridge.AnyBridge>>>

const combine = <Bs extends ReadonlyArray<ReadonlyArray<Bridge.AnyBridge>>>(bindings: {
  readonly [I in keyof Bs]: HostBindings<Bs[I]>
}): CombineHostBindings<{
  readonly [I in keyof Bs]: HostBindings<Bs[I]>
}> => {
  return {
    bridges: flattenTuples(bindings.map((b) => b.bridges)),
    receiverLayers: flattenTuples(bindings.map((b) => b.receiverLayers)),
    initialMessages: flattenTuples(bindings.map((b) => b.initialMessages)),
    onTransportReady: flattenTuples(bindings.map((b) => b.onTransportReady)),
  }
}

/**
 * Build the Effect that runs every binding's `onTransportReady` (with
 * the tuple-typed sender) — concurrently, fault-isolated via
 * `catchAllCause`/`logError` so one binding's defect doesn't block the
 * others. Bindings whose slot is `undefined` are skipped. Returns an
 * Effect; the React caller `runFork`s it once and interrupts the fiber
 * on unmount for proper teardown.
 *
 * @remarks
 * Each `onTransportReady[i]` is typed against `[Bridges[i]]`, but
 * `send` is `MessageSender<Bridges, 'Host'>` (the full-tuple sender).
 * The cast is the contravariance-to-`out`-annotation gap on
 * `MessageSender` — at runtime the per-slot callback only fires
 * `bridges[i]`-shaped messages, which the full-tuple sender accepts.
 */
const callTransportReady = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(
  bindings: HostBindings<Bridges>,
  send: BridgeTransport.MessageSender<Bridges, 'Host'>
): Effect.Effect<void> =>
  Effect.all(
    bindings.onTransportReady.map((callback) => {
      if (callback === undefined) return Effect.void

      return callback(send).pipe(Effect.catchAllCause(Effect.logError))
    }),
    { discard: true, concurrency: 'unbounded' }
  )

export { callTransportReady, combine, single }
export type {
  CombineHostBindings,
  HostBindings,
  HostHandlerTagId,
  InitialMessagesByBridge,
  OnTransportReadyByBridge,
}
