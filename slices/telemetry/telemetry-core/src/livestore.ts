import * as otel from '@opentelemetry/api'

export interface LivestoreOtelOptions {
  readonly tracer?: otel.Tracer
  readonly rootSpanContext?: otel.Context
}

let providerRegistered = false
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
 * tracer provider. Flips both the active-provider flag (so
 * `getLivestoreOtelOptions` starts handing out a real tracer) and the
 * init-attempted flag (so `whenOtelProviderReady` resolves).
 */
const markOtelProviderRegistered = (): void => {
  if (providerRegistered) return
  providerRegistered = true
  initAttempted = true
  flushReady()
}

/**
 * Called by telemetry adapters when init has finished without registering a
 * provider (no Sentry DSN, no OTLP endpoint, etc.). Unblocks
 * `whenOtelProviderReady` without flipping the active-provider flag — so
 * `getLivestoreOtelOptions` continues to return `{}` and Livestore falls back
 * to its internal tracer.
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
 * defer Livestore store creation until the provider decision is final: if
 * store options (including `otelOptions`) are evaluated before init runs,
 * Livestore bakes in whatever tracer was available at that moment for the
 * store's entire lifetime and per-call `otelContext` cannot recover it.
 */
const whenOtelProviderReady = (): Promise<void> => {
  if (initAttempted) return Promise.resolve()
  return readyPromise
}

/**
 * Build `otelOptions` for Livestore stores. Only returns a tracer when a
 * real OpenTelemetry SDK has been registered via `markOtelProviderRegistered`;
 * otherwise Livestore falls back to its internal tracer, which is compatible
 * with its duration-reading internals.
 */
const getLivestoreOtelOptions = (serviceName: string): LivestoreOtelOptions => {
  if (!providerRegistered) return {}
  const activeContext = otel.context.active()
  const tracer = otel.trace.getTracer(`${serviceName}.livestore`)
  if (otel.trace.getSpanContext(activeContext) === undefined) {
    return { tracer }
  }
  return { tracer, rootSpanContext: activeContext }
}

// The fields Livestore's `getCommitArgs` sniffs to decide whether the first
// argument is a `StoreCommitOptions` bag rather than an event or txn function.
const COMMIT_OPTIONS_KEYS: ReadonlyArray<string> = [
  'label',
  'skipRefresh',
  'otelContext',
  'spanLinks',
]

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'

const looksLikeCommitOptions = (v: unknown): v is Record<string, unknown> => {
  if (!isRecord(v)) return false
  for (const key of COMMIT_OPTIONS_KEYS) {
    if (key in v) return true
  }
  return false
}

const hasExplicitOtelContext = (v: unknown): boolean => isRecord(v) && v.otelContext !== undefined

interface StoreMethods {
  query(q: unknown, options?: Record<string, unknown>): unknown
  commit(...args: unknown[]): unknown
  subscribe(...args: unknown[]): unknown
}

const INJECTED_MARKER = Symbol.for('telemetry-core/livestore/injected-otel-context')

/**
 * Mutate a Livestore `Store` so that `query`, `commit`, and `subscribe` default
 * `options.otelContext` to the currently-active OpenTelemetry context. This
 * links Livestore spans to whatever span is active at call time — e.g. the
 * Effect HTTP-server span inside a request handler — without requiring every
 * call site to plumb the context through manually.
 *
 * Calls that already specify an `otelContext` are left untouched. Calling this
 * helper repeatedly on the same store is a no-op after the first call.
 */
const injectActiveOtelContext = <S extends StoreMethods>(store: S): S => {
  const marker = store as S & { [INJECTED_MARKER]?: true }
  if (marker[INJECTED_MARKER] === true) return store
  marker[INJECTED_MARKER] = true

  const origQuery = store.query.bind(store)
  store.query = (q: unknown, options?: Record<string, unknown>) => {
    if (options?.otelContext !== undefined) return origQuery(q, options)
    return origQuery(q, { ...options, otelContext: otel.context.active() })
  }

  const origCommit = store.commit.bind(store)
  store.commit = (...args: unknown[]) => {
    if (args.length === 0 || typeof args[0] === 'function') return origCommit(...args)
    const activeCtx = otel.context.active()
    const first = args[0]
    if (looksLikeCommitOptions(first)) {
      if (first.otelContext !== undefined) return origCommit(...args)
      return origCommit({ ...first, otelContext: activeCtx }, ...args.slice(1))
    }
    return origCommit({ otelContext: activeCtx }, ...args)
  }

  const origSubscribe = store.subscribe.bind(store)
  store.subscribe = (...args: unknown[]) => {
    if (args.length < 2) return origSubscribe(...args)
    const activeCtx = otel.context.active()
    const second = args[1]
    if (typeof second === 'function') {
      const third = args[2]
      if (hasExplicitOtelContext(third)) return origSubscribe(...args)
      if (isRecord(third)) {
        return origSubscribe(args[0], second, { ...third, otelContext: activeCtx })
      }
      return origSubscribe(args[0], second, { otelContext: activeCtx })
    }
    if (isRecord(second)) {
      if (second.otelContext !== undefined) return origSubscribe(...args)
      return origSubscribe(args[0], { ...second, otelContext: activeCtx }, ...args.slice(2))
    }
    return origSubscribe(...args)
  }

  return store
}

/**
 * Promise-chaining variant of `injectActiveOtelContext`. Awaits the global
 * OTel provider registration before resolving the store and injecting the
 * per-call context wrappers. Use this when constructing a Livestore store as
 * part of Effect Layer wiring so the layer is always bound to a store whose
 * operations link to the active OTel context.
 */
const injectActiveOtelContextWhenReady = async <S extends StoreMethods>(
  storeOrPromise: S | Promise<S>
): Promise<S> => {
  await whenOtelProviderReady()
  return injectActiveOtelContext(await storeOrPromise)
}

export {
  getLivestoreOtelOptions,
  injectActiveOtelContext,
  injectActiveOtelContextWhenReady,
  markOtelInitAttempted,
  markOtelProviderRegistered,
  whenOtelProviderReady,
}
