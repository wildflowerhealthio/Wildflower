let initAttempted = false
let resolveReady: (() => void) | null = null
const readyPromise: Promise<void> = new Promise<void>((resolve) => {
  resolveReady = resolve
})

const flushReady = (): void => {
  if (resolveReady !== null) {
    resolveReady()
    resolveReady = null
  }
}

/**
 * Called by telemetry adapters after they register a global OpenTelemetry
 * tracer provider. Marks init as attempted so `whenOtelProviderReady`
 * resolves.
 */
const markOtelProviderRegistered = (): void => {
  if (initAttempted) return
  initAttempted = true
  flushReady()
}

/**
 * Called by telemetry adapters when init has finished without registering a
 * provider (no Sentry DSN, no OTLP endpoint, etc.). Unblocks
 * `whenOtelProviderReady` just like `markOtelProviderRegistered` — the two
 * entry points exist so call sites read as the outcome they report.
 *
 * Hosts MUST call either this or `markOtelProviderRegistered` exactly once,
 * otherwise any consumer awaiting `whenOtelProviderReady` will hang.
 */
const markOtelInitAttempted = (): void => {
  if (initAttempted) return
  initAttempted = true
  flushReady()
}

/**
 * Resolves once telemetry init has been attempted — either successfully
 * (provider registered) or as a no-op (no telemetry configured). Use this to
 * defer tracer-capturing work until the provider decision is final: anything
 * that grabs a tracer before init runs bakes in whatever provider was
 * available at that moment.
 */
const whenOtelProviderReady = (): Promise<void> => {
  if (initAttempted) return Promise.resolve()
  return readyPromise
}

export { markOtelInitAttempted, markOtelProviderRegistered, whenOtelProviderReady }
