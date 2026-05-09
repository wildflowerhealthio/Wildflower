import { Effect, Option, pipe, Stream, SubscriptionRef, type Runtime } from 'effect'

/**
 * Process-scoped slot for the configured Effect Runtime. The embedded
 * SPA, standalone-web bundle, and Expo host all share one runtime
 * (logger, services) across module-load call sites that can't easily
 * thread a runtime through. Backed by a `SubscriptionRef` so the async
 * read can subscribe to slot changes.
 *
 * Module-scoped: each loaded copy of `contracts-core` has its own slot.
 */
const _runtimeRef = Effect.runSync(
  SubscriptionRef.make<Runtime.Runtime<never> | undefined>(undefined)
)

/** Install the process's Effect runtime. Call once at app startup. */
const setEffectRuntime = (runtime: Runtime.Runtime<never>): void => {
  Effect.runSync(SubscriptionRef.set(_runtimeRef, runtime))
}

/**
 * Read the installed Effect runtime synchronously.
 *
 * @throws when {@link setEffectRuntime} hasn't been called — silent
 * fallback to `Runtime.defaultRuntime` would mask a wiring mistake.
 * Callers that can wait should use {@link getEffectRuntimeAsync}.
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
 * {@link setEffectRuntime} has been called. Resolves immediately if
 * the slot is already populated.
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

/** Test-only reset; production code should never clear a populated slot. */
const _unsafeResetEffectRuntime = (): Promise<void> => {
  return Effect.runPromise(SubscriptionRef.set(_runtimeRef, undefined))
}

export {
  _unsafeResetEffectRuntime,
  getEffectRuntimeOrThrow,
  getEffectRuntimeAsync,
  setEffectRuntime,
}
