import type { Runtime } from 'effect'

/**
 * Process-scoped slot for the Effect Runtime that React (and other
 * consumers) should run Effects against.
 *
 * The contract:
 *
 * 1. The app's entrypoint — `apps/wildflower-react/src/main-embedded.tsx`
 *    on the embedded surface, `main-web.tsx` standalone — calls
 *    {@link setInteropRuntime} **before any other consumer reads the
 *    slot**. That includes the `makeWebTransport(...)` Effect, every
 *    React component that wants to log, etc.
 * 2. Consumers read the slot via {@link getInteropRuntime}. Reading
 *    before the app has initialised throws — this is intentional, since
 *    the alternative (silently falling back to `Runtime.defaultRuntime`)
 *    would mask wiring mistakes that change which logger / services
 *    every other Effect inherits.
 *
 * The slot is module-scoped (one per loaded bundle); the embedded SPA,
 * the standalone-web bundle, and the Expo host each get their own
 * instance because each loads its own copy of `interop-core`.
 *
 * `Runtime.Runtime<never>` (no requirements) is the slot's static
 * shape. Apps that want more capable Effects (e.g. requiring a
 * telemetry service) can either widen the slot's runtime to provide
 * those services, or hand callers narrower-typed Effects that already
 * have everything they need provided.
 */
let _runtime: Runtime.Runtime<never> | undefined

/**
 * Install the process's interop runtime. Call once at app startup
 * before any consumer reads the slot. Subsequent calls replace the
 * runtime; this is intended for test setup, not for production
 * re-wiring.
 */
const setInteropRuntime = (runtime: Runtime.Runtime<never>): void => {
  _runtime = runtime
}

/**
 * Read the installed interop runtime. Throws if the app entrypoint
 * hasn't called {@link setInteropRuntime} yet — silent fallback would
 * mask a wiring mistake that changes which logger every other Effect
 * uses.
 */
const getInteropRuntime = (): Runtime.Runtime<never> => {
  if (_runtime === undefined) {
    throw new Error(
      '[interop] runtime not initialized; call `setInteropRuntime(...)` at app startup before any consumer reads it'
    )
  }
  return _runtime
}

/**
 * Test-only reset. Not part of the public API; the leading underscore
 * and `unsafe` qualifier flag it as such. Production code should never
 * clear the slot once set.
 */
const _unsafeResetInteropRuntime = (): void => {
  _runtime = undefined
}

export { _unsafeResetInteropRuntime, getInteropRuntime, setInteropRuntime }
