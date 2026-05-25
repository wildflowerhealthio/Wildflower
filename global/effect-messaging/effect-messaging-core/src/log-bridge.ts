import { Effect, type Layer, Schema } from 'effect'
import * as Bridge from './bridge.ts'
import type * as MessageHandler from './message-handler.ts'

/**
 * Console-method levels mirrored across the LogBridge wire.
 *
 * @remarks
 * Five literals matching `console.<level>`. `'log'` is the browser
 * console's INFO-level alias; the default host receiver maps it to
 * `Effect.logInfo`. The `LogLevel` namespace from `effect` covers the
 * Effect side; this `LogLevel` is the *wire* shape, picked to match
 * `console`'s surface so the web sender can dispatch by method name
 * without a translation table.
 */
const LogLevel = Schema.Literal('debug', 'info', 'log', 'warn', 'error')

/** Decoded type alias for {@link LogLevel}'s five wire literals. */
type LogLevel = Schema.Schema.Type<typeof LogLevel>

/**
 * Inner (post-`parseJson`) struct shape for a Log message. Exposed so
 * sender helpers that can't carry the full `parseJson` runtime (e.g.
 * the `browser-sniffer-injected` script, which is `Function.prototype.toString`'d
 * into arbitrary pages and can't import the schema runtime) can still
 * type-import the wire shape.
 */
const LogMessageBody = Schema.TaggedStruct('Log', {
  level: LogLevel,
  payload: Schema.Array(Schema.Unknown),
})

/**
 * Wire-format schema for `Log` messages: the JSON-encoded tagged struct
 * `{ _tag: 'Log', level, payload }`. `payload` is an unknown-array so
 * the original `console.<level>(...args)` survives as-is (strings,
 * numbers, plain objects, and arrays round-trip via per-entry
 * `JSON.stringify`).
 */
const LogMessage = Schema.parseJson(LogMessageBody)

/** Decoded payload the host receives for each web-side console emission. */
interface LogPayload {
  readonly level: LogLevel
  readonly payload: readonly unknown[]
}

/**
 * Map a wire log level to its matching Effect logger entry point. `'log'`
 * mirrors the browser console's INFO-level alias — Effect has no
 * distinct "log" rung, so it lands at INFO alongside `'info'`.
 */
const effectLogFor: Record<LogLevel, (...args: ReadonlyArray<unknown>) => Effect.Effect<void>> = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  log: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
}

/** Concrete bridge type for the LogBridge — one-way Web → Host. */
type LogBridgeBridge = Bridge.Bridge<
  'Log',
  Record<never, never>,
  { readonly Log: typeof LogMessage }
>

/** Internal Bridge.Bridge instance — wrapped in the {@link LogBridge} surface below. */
const baseBridge: LogBridgeBridge = Bridge.make({
  name: 'Log',
  hostToWeb: [] as const,
  webToHost: [['Log', LogMessage]] as const,
})

/**
 * Default host-side receiver: maps each `Log` message's wire `level`
 * onto the matching `Effect.log<Level>` and spreads the message's
 * `payload` as variadic args, so SPA-side `console.<level>(...args)`
 * surfaces through the host's Effect logger at the original level.
 *
 * Compose into the host shell via `useLogHostBinding()` from
 * `effect-messaging-expo` (or directly as
 * `LogBridge.Host.ReceiverLayer({ Log: ... })` if the consumer wants
 * to override).
 */
const defaultHostReceiverLayer: Layer.Layer<MessageHandler.TagId<'Log', 'Host'>> =
  baseBridge.Host.ReceiverLayer({
    Log: ({ level, payload }) => effectLogFor[level](...payload),
  })

/**
 * Subset of `Console` we patch. Each method is the spread-args shape
 * the browser console uses (`console.warn(...args)`); the patched
 * versions forward through the LogBridge.
 *
 * @remarks
 * Declared as a record (not `Pick<Console, ...>`) so the type doesn't
 * pull in DOM lib's `Console` interface — keeps `effect-messaging-core`
 * platform-neutral and importable from non-DOM hosts.
 */
type LogBridgeConsole = Readonly<Record<LogLevel, (...args: unknown[]) => void>>

/**
 * Web-side helper: patch `globalThis.console.<level>` for the five
 * `LogLevel` methods so each call ships `{ _tag: 'Log', level, payload: args }`
 * through the supplied LogBridge sender. The original `console` object
 * identity is preserved (only the methods rotate) so any page code
 * that captured a bound reference still observes the new behaviour.
 *
 * Returns a teardown function that restores the original methods.
 * Calling it twice without an intervening install is a no-op.
 *
 * @remarks
 * Touching `globalThis.console` is universally available (Node, web,
 * RN, Hermes), so this helper stays in `-core` rather than a `-web`
 * package. The sender comes from the wired transport — typically:
 *
 * ```ts
 * const transport = await Effect.runPromise(makeTransport(...))
 * const teardown = LogBridge.installConsoleInterceptor((msg) =>
 *   Effect.runFork(transport.sendMessage(msg))
 * )
 * ```
 *
 * The interceptor's signature accepts a plain `(message) => void`
 * (already-ran) rather than an `Effect`-returning sender so callers
 * pick their own fiber strategy. Pass `(msg) => Effect.runFork(send(msg))`
 * for the common "fire-and-forget" wiring; pass a custom runner if the
 * fiber should join a specific scope.
 */
const installConsoleInterceptor = (
  send: (message: Schema.Schema.Type<typeof LogMessage>) => void
): (() => void) => {
  // Capture originals so teardown can restore them. `globalThis.console`
  // is the same object identity across web / node / RN — patching its
  // methods in place is the universal pattern.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const target = globalThis.console as unknown as LogBridgeConsole
  const originals: LogBridgeConsole = {
    debug: target.debug,
    info: target.info,
    log: target.log,
    warn: target.warn,
    error: target.error,
  }

  const makeForLevel =
    (level: LogLevel) =>
    (...args: unknown[]): void => {
      send({ _tag: 'Log', level, payload: args })
    }

  const patched: LogBridgeConsole = {
    debug: makeForLevel('debug'),
    info: makeForLevel('info'),
    log: makeForLevel('log'),
    warn: makeForLevel('warn'),
    error: makeForLevel('error'),
  }

  // Mutate the existing console object so captured references see the
  // patch. (Reassigning `globalThis.console = {...}` would leave
  // already-captured `const log = console.log` bindings pointing at the
  // originals.)
  Object.assign(globalThis.console, patched)

  let restored = false
  return (): void => {
    if (restored) return
    restored = true
    Object.assign(globalThis.console, originals)
  }
}

/**
 * Singleton {@link Bridge.Bridge} for cross-process `console.<level>(...)`
 * mirroring, plus the default host receiver and the web-side console
 * interceptor as fields on the same value.
 *
 * @remarks
 * The shape is `Bridge.Bridge` (so it composes into a transport tuple
 * exactly like any slice bridge) with two extra fields tacked on:
 *
 *  - `defaultHostReceiverLayer` — preferred via `useLogHostBinding()`
 *    in apps that aggregate via `HostBinding.aggregate`, but exported
 *    here so non-React hosts can wire it directly.
 *  - `installConsoleInterceptor` — the canonical Web-side wiring; patches
 *    the page's `console.<level>` to ride this bridge.
 *
 * Co-locating the bridge value and these helpers gives the same
 * single-import ergonomics slice bridges have (`NavigationBridgeExpo`
 * etc. bundle a bridge + slice helpers under one namespace) while
 * keeping the `Bridge.Bridge` surface verbatim — composition under
 * `Bridge.AnyBridge` still works through the inherited fields.
 *
 * `webToHost`-only; `hostToWeb` is empty (the host never asks the web
 * page to log on its behalf).
 */
const LogBridge: LogBridgeBridge & {
  readonly defaultHostReceiverLayer: typeof defaultHostReceiverLayer
  readonly installConsoleInterceptor: typeof installConsoleInterceptor
} = Object.assign(baseBridge, {
  defaultHostReceiverLayer,
  installConsoleInterceptor,
})

/** Static type alias for {@link LogBridge}, useful for `typeof LogBridge` constraints. */
type LogBridge = typeof LogBridge

export { LogBridge, LogLevel, LogMessage, LogMessageBody }
export type { LogPayload }
