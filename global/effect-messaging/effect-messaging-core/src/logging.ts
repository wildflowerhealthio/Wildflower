import { Effect, Schema } from 'effect'
import * as Bridge from './bridge.ts'

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

/**
 * Decoded payload the host receives for each web-side console emission.
 * Derived from {@link LogMessageBody} so the type stays in lockstep
 * with the wire schema — adding a field to the schema surfaces here
 * automatically.
 */
type LogPayload = Schema.Schema.Type<typeof LogMessageBody>

/**
 * Map a wire log level to its matching Effect logger entry point. `'log'`
 * mirrors the browser console's INFO-level alias — Effect has no
 * distinct "log" rung, so it lands at INFO alongside `'info'`.
 */
const effectLogForLevel: Record<
  LogLevel,
  (...args: ReadonlyArray<unknown>) => Effect.Effect<void>
> = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  log: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
}

/**
 * Default `Log` handler: spread the wire payload through the matching
 * `Effect.log<Level>` so SPA-side `console.<level>(...args)` surfaces
 * through the host's Effect logger at the original level. Exported so
 * callers wiring their own `onLog` override can fall back to it.
 */
const defaultOnLog = ({ level, payload }: LogPayload): Effect.Effect<void> =>
  effectLogForLevel[level](...payload)

/** Concrete bridge type for the LogBridge — one-way Web → Host. */
type LogBridge = Bridge.Bridge<'Log', Record<never, never>, { readonly Log: typeof LogMessage }>

/**
 * Singleton {@link Bridge.Bridge} for cross-process `console.<level>(...)`
 * mirroring. `webToHost`-only — the host never asks the web page to log
 * on its behalf.
 *
 * @remarks
 * Compose into a transport tuple like any slice bridge. The default
 * host handlers live in {@link defaultLogHostHandlers}; the
 * canonical web-side wiring is {@link installConsoleInterceptor}.
 */
const LogBridge: LogBridge = Bridge.make({
  name: 'Log',
  hostToWeb: [] as const,
  webToHost: [['Log', LogMessage]] as const,
})

/**
 * Default host-side handler record: dispatches each `Log` via
 * {@link defaultOnLog}. Compose into the host shell via
 * `useLogHostBinding()` from `effect-messaging-expo` (or directly here
 * if the consumer wants a non-React host).
 */
const defaultLogHostHandlers: Bridge.HalfHandlers<LogBridge['Host']> = {
  Log: defaultOnLog,
}

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
 * Module-level guard pairing each successful {@link installConsoleInterceptor}
 * call with its restore. While non-null, a second install is short-circuited
 * to a no-op teardown so the truly-original console methods aren't lost.
 */
let activeRestore: (() => void) | null = null

/**
 * Web-side helper: patch `globalThis.console.<level>` for the five
 * `LogLevel` methods so each call ships `{ _tag: 'Log', level, payload: args }`
 * through the supplied LogBridge sender. The original `console` object
 * identity is preserved (only the methods rotate) so any page code
 * that captured a bound reference still observes the new behaviour.
 *
 * Returns a teardown function that restores the original methods.
 *
 * **Lifecycle:**
 *
 * - **Teardown idempotency** — calling it twice without an intervening
 *   install is a no-op.
 * - **Install-twice protection** — a second `installConsoleInterceptor`
 *   call while a prior install is still active short-circuits and
 *   returns a no-op teardown. Without this guard, the second install
 *   would capture the already-patched methods as "originals" and the
 *   eventual teardown would restore to the patched versions, losing
 *   the truly-original references forever. Callers that want to swap
 *   the sender must teardown the first install before re-installing.
 *
 * @remarks
 * Touching `globalThis.console` is universally available (Node, web,
 * RN, Hermes), so this helper stays in `-core` rather than a `-web`
 * package. The sender comes from the wired transport — typically:
 *
 * ```ts
 * const transport = await Effect.runPromise(makeTransport(...))
 * const teardown = installConsoleInterceptor((msg) =>
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
  if (activeRestore !== null) {
    // A prior install is still active. Re-installing now would
    // re-capture the already-patched methods as `originals` and lose
    // the real ones on teardown. Short-circuit to a no-op teardown
    // and let the caller observe the JSDoc'd contract.
    return (): void => undefined
  }

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
  const restore = (): void => {
    if (restored) return
    restored = true
    Object.assign(globalThis.console, originals)
    if (activeRestore === restore) activeRestore = null
  }
  activeRestore = restore
  return restore
}

export {
  defaultLogHostHandlers,
  defaultOnLog,
  effectLogForLevel,
  installConsoleInterceptor,
  LogBridge,
  LogLevel,
  LogMessage,
  LogMessageBody,
}
export type { LogPayload }
