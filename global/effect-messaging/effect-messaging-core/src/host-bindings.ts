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
 * Per-bridge `onPageReady` callbacks, parallel-indexed against the
 * surrounding `Bridges` tuple. Slot `I` is either undefined (no
 * post-page-ready work) or a callback whose sender is narrowly typed to
 * `Bridges[I]`.
 *
 * @remarks
 * `onPageReady` fires once on **every** `__Ready` the host receives,
 * not just the first — so a WebView reload, hot refresh, or any other
 * page (re)boot re-runs every slice's initial-state push. Slices that
 * want one-shot setup must guard themselves (`useRef<boolean>`); but
 * because the typical body is a sender-ref write plus a current-value
 * push (token, route, etc.), re-firing is the safer default.
 */
type OnPageReadyByBridge<Bridges extends ReadonlyArray<Bridge.AnyBridge>> = {
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
 * - `onPageReady[i]` runs on every page `__Ready`, with the typed sender
 *   for `bridges[i]` (or `undefined` for slices with no post-page-ready
 *   work). Fires on the first page load **and** on every subsequent
 *   reload — see {@link OnPageReadyByBridge}.
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
  readonly onPageReady: OnPageReadyByBridge<Bridges>
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
 *   onPageReady: (send) => send({ _tag: 'Greet', value: 'hello' }),
 * })
 * ```
 */
const single = <const B extends Bridge.AnyBridge>(binding: {
  readonly bridge: B
  readonly handlers: MessageHandler.HandlersFor<B['WebToHost']>
  readonly initialMessages?: ReadonlyArray<Bridge.UrlParamableMessage<readonly [B]>>
  readonly onPageReady?: (
    send: BridgeTransport.MessageSender<readonly [B], 'HostToWeb'>
  ) => Effect.Effect<void>
}): HostBindings<readonly [B]> => ({
  bridges: [binding.bridge] as const,
  handlers: [binding.handlers],
  initialMessages: [binding.initialMessages ?? []] as const,
  onPageReady: [binding.onPageReady] as const,
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
 * {@link callPageReady} consume.
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
    onPageReady: flattenTuples(bindings.map((b) => b.onPageReady)),
  }
}

/**
 * Build the Effect that runs every binding's `onPageReady` (with the
 * tuple-typed sender) — concurrently, fault-isolated via
 * `catchAllCause`/`logError` so one binding's defect doesn't block the
 * others. Bindings whose slot is `undefined` are skipped.
 *
 * @remarks
 * `BridgedWebView` hands a `(send) => callPageReady(bindings, send)`
 * wrapper to `makeHostTransport`'s `onPageReady` config, so this runs
 * once on every `__Ready` the host receives — first load and every
 * subsequent page reload. Each `onPageReady[i]` is typed against
 * `[Bridges[i]]`. The full-tuple sender accepts every per-slot message —
 * TS resolves the call structurally because `MessageSender` distributes
 * its outbound union over `Bridges[number]`, so handing the wide sender
 * to a narrow slot fires only that slot's payloads at runtime.
 */
const callPageReady = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(
  bindings: HostBindings<Bridges>,
  send: BridgeTransport.MessageSender<Bridges, 'HostToWeb'>
): Effect.Effect<void> =>
  Effect.all(
    bindings.onPageReady.map((callback) => {
      if (callback === undefined) return Effect.void

      return callback(send).pipe(Effect.catchAllCause(Effect.logError))
    }),
    { discard: true, concurrency: 'unbounded' }
  )

export { callPageReady, combine, single }
export type { CombineHostBindings, HostBindings, InitialMessagesByBridge, OnPageReadyByBridge }
