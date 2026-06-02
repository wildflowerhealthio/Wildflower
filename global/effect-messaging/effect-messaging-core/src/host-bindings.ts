import { Effect } from 'effect'
import { flattenTuples } from 'kitchen-sink/types'
import type * as BridgeTransport from './bridge-transport.ts'
import type * as Bridge from './bridge.ts'
import type * as MessageHandler from './message-handler.ts'

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
    | ((
        send: BridgeTransport.MessageSender<readonly [Bridges[I]], 'HostToWeb'>
      ) => Effect.Effect<void>)
    | undefined
}

/**
 * Uniform host-side wiring contract. Four parallel-indexed arrays:
 *
 * - `bridges[i]` is the bridge declaration.
 * - `handlers[i]` is `bridges[i]`'s Host-side inbound handler record.
 * - `initialMessages[i]` are URL-param-seeded payloads for `bridges[i]`
 *   (zero or many).
 * - `onTransportReady[i]` runs once the transport is built, with the
 *   typed sender for `bridges[i]` (or `undefined` for slices that don't
 *   need post-mount work).
 *
 * Compose multiple slices via {@link combine}: the four arrays
 * concatenate index-aligned, so the result satisfies the same
 * parallel-tuple shape `BridgeTransport.makeHostTransport` consumes.
 * Single-bridge slices construct theirs via {@link single}.
 *
 * See [Host Bindings Explanation](../docs/Host%20Bindings%20Explanation.md).
 */
interface HostBindings<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly bridges: Bridges
  readonly handlers: Bridge.HandlersByBridge<Bridges, 'WebToHost'>
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
 *   bridge: NavigationBridge,
 *   handlers: { RouteChanged: onRouteChanged, UiReady: onUiReady },
 *   initialMessages: [{ _tag: 'Setup', path: '/' }],
 *   onTransportReady: (send) => send({ _tag: 'Greet', value: 'hello' }),
 * })
 * ```
 */
const single = <const B extends Bridge.AnyBridge>(binding: {
  readonly bridge: B
  readonly handlers: MessageHandler.HandlersFor<B['WebToHost']>
  readonly initialMessages?: ReadonlyArray<Bridge.UrlParamableMessage<readonly [B]>>
  readonly onTransportReady?: (
    send: BridgeTransport.MessageSender<readonly [B], 'HostToWeb'>
  ) => Effect.Effect<void>
}): HostBindings<readonly [B]> => ({
  bridges: [binding.bridge] as const,
  handlers: [binding.handlers],
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
 * parallel-tuple invariant `BridgeTransport.makeHostTransport` and
 * {@link callTransportReady} consume.
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
 * `flattenTuples` (from `kitchen-sink/types`) preserves the
 * tuple-mapped shape that `Array.prototype.flatMap` would widen to
 * `T[]` — the parallel-tuple invariant carries through without any
 * runtime cast.
 *
 * Takes a single tuple parameter rather than rest (`...bindings`)
 * because `babel-preset-expo` transpiles rest params to `new Array(_len)`,
 * and `bridge.ts` / `bridge-transport.ts` import the Effect `Array`
 * module at the top of the bundled dist — which shadows the global
 * `Array` constructor and crashes at runtime.
 */
const combine = <Bs extends ReadonlyArray<ReadonlyArray<Bridge.AnyBridge>>>(bindings: {
  readonly [I in keyof Bs]: HostBindings<Bs[I]>
}): CombineHostBindings<{
  readonly [I in keyof Bs]: HostBindings<Bs[I]>
}> => {
  return {
    bridges: flattenTuples(bindings.map((b) => b.bridges)),
    handlers: flattenTuples(bindings.map((b) => b.handlers)),
    initialMessages: flattenTuples(bindings.map((b) => b.initialMessages)),
    onTransportReady: flattenTuples(bindings.map((b) => b.onTransportReady)),
  }
}

/**
 * Build the Effect that runs every binding's `onTransportReady` (with
 * the tuple-typed sender) — concurrently, fault-isolated via
 * `catchAllCause`/`logError` so one binding's defect doesn't block the
 * others. Bindings whose slot is `undefined` are skipped. Returns an
 * Effect; the React caller runs it on a component-scoped fiber that
 * is interrupted on unmount for proper teardown.
 *
 * @remarks
 * Each `onTransportReady[i]` is typed against `[Bridges[i]]`. The
 * full-tuple sender accepts every per-slot message — TS resolves the
 * call structurally because `MessageSender` distributes its outbound
 * union over `Bridges[number]`, so handing the wide sender to a narrow
 * slot fires only that slot's payloads at runtime.
 */
const callTransportReady = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(
  bindings: HostBindings<Bridges>,
  send: BridgeTransport.MessageSender<Bridges, 'HostToWeb'>
): Effect.Effect<void> =>
  Effect.all(
    bindings.onTransportReady.map((callback) => {
      if (callback === undefined) return Effect.void

      return callback(send).pipe(Effect.catchAllCause(Effect.logError))
    }),
    { discard: true, concurrency: 'unbounded' }
  )

export { callTransportReady, combine, single }
export type { CombineHostBindings, HostBindings, InitialMessagesByBridge, OnTransportReadyByBridge }
