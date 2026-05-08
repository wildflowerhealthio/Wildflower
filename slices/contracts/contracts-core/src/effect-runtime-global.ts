import { Effect, Option, pipe, Stream, SubscriptionRef, type Runtime } from 'effect'

/**
 * Process-scoped slot for the Effect Runtime that React (and other
 * consumers) should run Effects against. Wildflower-specific: the
 * embedded SPA, the standalone-web bundle, and the Expo host all
 * use this single-slot pattern to share one configured runtime
 * (logger, services) across module-load-time call sites that can't
 * easily thread a runtime through.
 *
 * The contract:
 *
 * 1. The app's entrypoint — on the embedded surface
 *    `apps/wildflower-react/src/embedded-runtime.ts` — calls
 *    {@link setEffectRuntime} once the runtime is built. Until that
 *    happens, the slot is empty.
 * 2. Sync consumers that need the runtime *now* read it via
 *    {@link getEffectRuntimeOrThrow}. Reading before the app has
 *    called {@link setEffectRuntime} throws — silent fallback to
 *    `Runtime.defaultRuntime` would mask a wiring mistake that
 *    changes which logger / services every other Effect inherits.
 * 3. Consumers that can wait read via {@link getEffectRuntimeAsync},
 *    which suspends until the slot is populated. Useful for code
 *    that runs in parallel with module-load setup (e.g. lazy
 *    React-mounted hooks) and wants to avoid an ordering constraint
 *    on `setEffectRuntime`.
 *
 * Backed by a `SubscriptionRef` so the async variant can subscribe
 * to slot changes — `let`-mutable state would force a polling loop.
 * The slot is module-scoped (one per loaded bundle); the embedded
 * SPA, the standalone-web bundle, and the Expo host each get their
 * own instance because each loads its own copy of `contracts-core`.
 *
 * `Runtime.Runtime<never>` (no requirements) is the slot's static
 * shape. Apps that want more capable Effects (e.g. requiring a
 * telemetry service) can either widen the slot's runtime to provide
 * those services, or hand callers narrower-typed Effects that
 * already have everything they need provided.
 */
const _runtimeRef = Effect.runSync(
  SubscriptionRef.make<Runtime.Runtime<never> | undefined>(undefined)
)
/**
 * Install the process's Effect runtime. Call once at app startup
 * before any consumer reads the slot. Subsequent calls replace the
 * runtime; this is intended for test setup, not for production
 * re-wiring.
 */
const setEffectRuntime = (runtime: Runtime.Runtime<never>): void => {
  Effect.runSync(SubscriptionRef.set(_runtimeRef, runtime))
}

/**
 * Read the installed Effect runtime synchronously. Throws if the app
 * entrypoint hasn't called {@link setEffectRuntime} yet — silent
 * fallback would mask a wiring mistake that changes which logger
 * every other Effect uses. Callers that can wait for the slot to be
 * populated should use {@link getEffectRuntimeAsync} instead.
 */
const getEffectRuntimeOrThrow = (): Runtime.Runtime<never> => {
  const runtime = Effect.runSync(SubscriptionRef.get(_runtimeRef))
  if (runtime === undefined) {
    throw new Error(
      '[contracts] runtime not initialized; call `setEffectRuntime(...)` at app startup before any consumer reads it'
    )
  }
  return runtime
}

/**
 * Resolve to the installed Effect runtime, suspending until
 * {@link setEffectRuntime} has been called. Subscribes to the
 * underlying `SubscriptionRef`'s change stream and takes the first
 * non-`undefined` value, so callers that race the entrypoint don't
 * need to enforce module-load ordering.
 *
 * Resolves immediately if the slot is already populated when this is
 * called — `SubscriptionRef.changes` re-emits the current value to
 * new subscribers.
 */
const getEffectRuntimeAsync = async (): Promise<Runtime.Runtime<never>> => {
  return await Effect.runPromise(
    pipe(
      _runtimeRef.changes,
      Stream.filter((r): r is Runtime.Runtime<never> => r !== undefined),
      Stream.take(1),
      Stream.runHead,
      Effect.map(Option.getOrThrow)
    )
  )
}

/**
 * Test-only reset. Not part of the public API; the leading
 * underscore and `unsafe` qualifier flag it as such. Production code
 * should never clear the slot once set. Returns a `Promise<void>`
 * (the underlying `SubscriptionRef.set` runs through `runPromise`),
 * so test hooks should `await` it.
 */
const _unsafeResetEffectRuntime = (): Promise<void> => {
  return Effect.runPromise(SubscriptionRef.set(_runtimeRef, undefined))
}

export {
  _unsafeResetEffectRuntime,
  getEffectRuntimeOrThrow,
  getEffectRuntimeAsync,
  setEffectRuntime,
}
