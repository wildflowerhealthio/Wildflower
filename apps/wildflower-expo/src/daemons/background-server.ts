import { Cause, Duration, Effect, Exit, Fiber, Layer } from 'effect'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { useEffect, useMemo } from 'react'
import { AppState } from 'react-native'
import BackgroundService, { type BackgroundTaskOptions } from 'react-native-background-actions'
import { reactNativeTelemetryLayerFromEnv } from 'telemetry-react-native'
import { TunnelStore } from 'tunnel-core/livestore'
import { TunnelDaemon } from 'tunnel-expo'
import { type useWildflowerStore, WildflowerStore } from '../livestore/livestore-store.ts'
import { HttpServerDaemonLive } from './http-server.ts'

/** The loaded wildflower store handle (livestore `Store` + `@livestore/react` API). */
type WildflowerStoreHandle = ReturnType<typeof useWildflowerStore>

/**
 * Latency bound between a stop request (`BackgroundService.stop()`, fired
 * on unmount / `requestedRunning` → false) and the Effect scope actually
 * tearing down. `stop()` flips `isRunning()` to `false` but does not await
 * our task; the task observes the flip on its next poll tick and only then
 * interrupts the launch fiber. 500ms keeps the HTTP listener / tunnel
 * teardown prompt without busy-spinning the JS thread.
 */
const STOP_POLL_INTERVAL_MS = 500

/**
 * Upper bound on how long the background task will wait for the daemon's
 * scope teardown after a stop signal. iOS gives roughly 5s before reclaiming
 * an expired task; 3s leaves enough margin for the tunnel FIN to flush while
 * still settling the foreground service well inside that window. If we hit
 * the cap something is wedged — log a warning and let `react-native-background-actions`
 * tear the service down anyway.
 */
const TEARDOWN_TIMEOUT = Duration.seconds(3)

/**
 * The merged on-device daemon launch as a forkable Effect — the same
 * `Layer.mergeAll(HttpServerDaemonLive, TunnelDaemon)` composition that
 * previously ran under `useComponentScopedRunner`, now hoisted here so the
 * background task can fork it. The wildflower store is provided once at the
 * outer layer; the tunnel + LHS slices get their own projections.
 *
 * Merge order is load-bearing: `Layer.mergeAll`'s finalizers run in
 * reverse-merge order, so `TunnelDaemon`'s finalizers (which release the
 * relay-side subdomain lease) run **before** `HttpServerDaemonLive`'s
 * (which closes the local HTTP listener). That order matters because the
 * relay can still be sending bytes through to the listener until the
 * tunnel FIN is acknowledged; swapping the args would race the lease
 * release against the listener tear-down.
 *
 * `Layer.launch` never returns normally — it holds the scope open until the
 * fiber is interrupted, at which point the scoped finalizers (HTTP listener
 * close, `tunnel.close()`) run.
 *
 * `Effect.onExit` distinguishes the three exit shapes so debug logs tell us
 * **why** the runtime ended: deliberate interruption (the common case — user
 * toggled stop, OS expiration, Metro reload) logs info, real failures log
 * error with a pretty cause, clean success (unreachable in practice) logs
 * debug. The previous `Effect.onError` lumped interruption and crash
 * together and made StrictMode mount/unmount cycles look like errors.
 */
const makeServerRuntime = (store: WildflowerStoreHandle): Effect.Effect<never, never, never> =>
  Layer.mergeAll(HttpServerDaemonLive, TunnelDaemon).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(WildflowerStore, store),
        TunnelStore.layerFrom(store),
        LocalHttpServerStore.layerFrom(store)
      )
    ),
    Layer.provide(reactNativeTelemetryLayerFromEnv()),
    Layer.launch,
    Effect.onExit((exit) =>
      Exit.match(exit, {
        onSuccess: () => Effect.logDebug('Server runtime exited cleanly'),
        onFailure: (cause) =>
          Cause.isInterruptedOnly(cause)
            ? Effect.logInfo('Server runtime stopped by request (interrupted)')
            : Effect.logError(`HTTP + Tunnel Daemon failed: ${Cause.pretty(cause)}`),
      })
    ),
    Effect.orDie
  )

/**
 * Notification / foreground-service descriptor for the server task.
 *
 * Android-only fields (`taskTitle` / `taskDesc` / `taskIcon` / `color`)
 * drive the mandatory foreground-service notification. `foregroundServiceType:
 * ['dataSync']` matches the manifest declaration the config plugin injects
 * (required on Android 14+). `linkingURI` uses the app's `wildflower-expo`
 * scheme so tapping the notification deep-links back in. iOS ignores all of
 * these and simply runs the task in its limited background window.
 */
const SERVER_BACKGROUND_OPTIONS: BackgroundTaskOptions = {
  taskName: 'WildflowerServer',
  taskTitle: 'Wildflower is running',
  taskDesc: 'Serving the local app and tunnel',
  taskIcon: { name: 'ic_launcher', type: 'mipmap' },
  color: '#fdf4e3',
  linkingURI: 'wildflower-expo://',
  foregroundServiceType: ['dataSync'],
}

/**
 * The background task body: fork the daemon launch, await a stop signal,
 * then interrupt the launch fiber and wait for its teardown before the
 * returned promise settles — so the HTTP listener close and (critically)
 * the tunnel lease release run before `react-native-background-actions`
 * tears the foreground service down.
 *
 * Two independent stop cues are honoured: polling `BackgroundService.isRunning()`
 * (covers `stop()` from unmount / `requestedRunning` → false / Android) and the
 * iOS `'expiration'` event — which fires shortly before the OS reclaims the
 * background window and, unlike `stop()`, leaves `isRunning()` reporting `true`.
 * Whichever fires first wins.
 *
 * Implemented as an `Effect.scoped` block so the listener + poll interval are
 * acquired through the Effect scope and released compositionally — on the
 * natural resume path, on scope close, and on interruption. The fiber is
 * forked into the same scope, so even if this Effect itself is interrupted
 * the daemon is torn down. The explicit `Fiber.interrupt` is bounded by
 * {@link TEARDOWN_TIMEOUT}: in the common case the tunnel FIN flushes well
 * inside the budget; in pathological cases we log a warning and let the
 * background-actions library proceed rather than hang the service. Debug
 * logs at each transition let the full shutdown narrative be reconstructed
 * from telemetry.
 *
 * Exported for unit testing; production code reaches it via {@link reconcile}.
 */
const runServerUntilStopped = (
  runtime: Effect.Effect<never, never, never>,
  pollIntervalMs: number = STOP_POLL_INTERVAL_MS
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.logInfo('Background server task starting')

        // `forkDaemon` (not `Effect.fork`) so the daemon is **not** bound to
        // this scope. With `Effect.fork`, scope close awaits the child fiber's
        // interruption — meaning a slow finalizer (typically the HTTP listener
        // release) makes the whole `runServerUntilStopped` promise hang past
        // the explicit `Fiber.interrupt` timeout below. That hang leaves
        // `BackgroundService.isRunning()` reporting `true`, so the
        // foreground-resume path in `useBackgroundServerDaemon` sees no work
        // to do and the user is left with a half-dead server.
        //
        // With `forkDaemon` the fiber runs detached; the explicit interrupt
        // below is the orderly cleanup, and if it times out the fiber
        // continues its finalizers in the background while `runPromise`
        // resolves promptly so the foreground service can settle.
        const daemonFiber = yield* Effect.forkDaemon(runtime)

        const source = yield* Effect.async<'expiration' | 'isRunning-poll'>((resume) => {
          let cleaned = false
          // Idempotent teardown of the listener + interval. Runs once on
          // whichever path completes first: natural resume below, or the
          // returned `Effect.sync` if Effect.async is interrupted (scope
          // close, parent fiber interruption).
          const cleanup = (): void => {
            if (cleaned) return
            cleaned = true
            clearInterval(poll)
            BackgroundService.removeListener('expiration', onExpiration)
          }
          const finish = (s: 'expiration' | 'isRunning-poll'): void => {
            if (cleaned) return
            cleanup()
            resume(Effect.succeed(s))
          }
          const onExpiration = (): void => finish('expiration')
          BackgroundService.on('expiration', onExpiration)
          const poll = setInterval(() => {
            if (!BackgroundService.isRunning()) finish('isRunning-poll')
          }, pollIntervalMs)
          return Effect.sync(cleanup)
        })

        yield* Effect.logInfo(`Stop signal received from ${source}`)
        yield* Effect.logInfo('Interrupting daemon fiber')
        const interruptStart = yield* Effect.sync(() => Date.now())

        yield* Fiber.interrupt(daemonFiber).pipe(
          Effect.timeout(TEARDOWN_TIMEOUT),
          Effect.tap(() =>
            Effect.logInfo(`Daemon fiber interrupted in ${Date.now() - interruptStart}ms`)
          ),
          Effect.catchAll(() =>
            Effect.logWarning(
              `Background server teardown exceeded ${Duration.toMillis(TEARDOWN_TIMEOUT)}ms; forcing shutdown after ${Date.now() - interruptStart}ms (daemon fiber may continue running in background)`
            )
          )
        )

        yield* Effect.logInfo('Background server task exited')
      })
    )
  )

// Serialises start/stop against a single promise chain so a rapid mount →
// unmount → mount (React StrictMode in dev, or a fast `requestedRunning`
// toggle) can never overlap two server launches — which on iOS, where
// `start()` runs the task in-process, would bind the port twice. `desired`
// is read when a step *executes* (not when enqueued), so a burst collapses
// to the final intent with at most one `start`/`stop`.
let desiredRunning = false
let activeRuntime: Effect.Effect<never, never, never> | null = null
let reconciling: Promise<void> = Promise.resolve()

const reconcile = (running: boolean, runtime: Effect.Effect<never, never, never>): void => {
  desiredRunning = running
  activeRuntime = runtime
  reconciling = reconciling.then(async () => {
    if (desiredRunning && activeRuntime !== null && !BackgroundService.isRunning()) {
      const activeAtStart = activeRuntime
      await BackgroundService.start(
        () => runServerUntilStopped(activeAtStart),
        SERVER_BACKGROUND_OPTIONS
      )
    } else if (!desiredRunning && BackgroundService.isRunning()) {
      await BackgroundService.stop()
    }
  })
}

/**
 * Body of the AppState `'active'` handler in
 * {@link useBackgroundServerDaemon}. Mirrors the boot-time un-pause in
 * `wildflowerStoreOptions.boot` — committing `requestedRunning: true`
 * iff the user paused mid-session — then asks the caller to reconcile
 * to the known-true desired state. Passes `true` to `startReconcile`
 * rather than the incoming `requestedRunning` so a just-emitted commit
 * isn't masked by the listener's stale closure value.
 *
 * Takes `commit` and `startReconcile` as callbacks rather than a full
 * store + runtime so the helper's surface area is exactly what it
 * needs — making the unit tests trivial and the production call site
 * the only place that has to know about livestore Store / Effect
 * runtime types.
 */
const handleForegroundActive = (
  requestedRunning: boolean,
  commit: WildflowerStoreHandle['commit'],
  startReconcile: (running: boolean) => void
): void => {
  if (!requestedRunning) {
    commit(ServerState.events.localHttpServerStateSet({ requestedRunning: true }))
  }
  startReconcile(true)
}

/**
 * Mount-and-intent-tied background server. Replaces the prior
 * `useComponentScopedRunner` launch: the merged HTTP-server + tunnel daemon
 * now runs inside a `react-native-background-actions` foreground service so
 * it survives the app being backgrounded (a true long-lived service on
 * Android; a best-effort, time-limited window on iOS).
 *
 * Lifecycle:
 *  - **start** when mounted with `ServerState.requestedRunning === true`;
 *  - **stop** when `requestedRunning` flips to `false` (the in-app pause
 *    toggle) and on unmount;
 *  - **stop** when the OS ends the task — `BackgroundService.stop()`
 *    (Android) or the `'expiration'` event (iOS), both observed inside
 *    {@link runServerUntilStopped};
 *  - **restart** when the app returns to the foreground after the OS
 *    expired the task — without this hook the React state still says
 *    `requestedRunning: true` but `BackgroundService.isRunning()` is
 *    `false`, and nothing re-triggers `reconcile`;
 *  - **unpause** when the app returns to the foreground from a paused
 *    state — mirrors the boot-time nudge in
 *    `wildflowerStoreOptions.boot`, so the in-app pause toggle is
 *    per-session rather than persisted across foreground cycles. The
 *    app is non-functional without the LHS daemon, so every app-start
 *    path (cold start, Expo reload, foreground return) re-asserts
 *    `requestedRunning: true`.
 *
 * Keyed on the primitive `requestedRunning`, not the query row, so the
 * daemon-written `running` / `port` / `error` updates don't churn the
 * service. The `runtime` is memoised on the stable store handle.
 */
const useBackgroundServerDaemon = (store: WildflowerStoreHandle): void => {
  const { requestedRunning } = store.useQuery(ServerState.queries.current$)
  const runtime = useMemo(() => makeServerRuntime(store), [store])

  useEffect(() => {
    reconcile(requestedRunning, runtime)
    return (): void => {
      reconcile(false, runtime)
    }
  }, [runtime, requestedRunning])

  // Foreground re-entry: nudge intent back to running and reconcile.
  // The reconcile still has to run when `requestedRunning` was already
  // true because iOS expiration silently kills the foreground service
  // while the app sleeps and the `[runtime, requestedRunning]` effect
  // above won't re-fire on its own. See {@link handleForegroundActive}.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        handleForegroundActive(requestedRunning, store.commit.bind(store), (running) => {
          reconcile(running, runtime)
        })
      }
    })
    return (): void => {
      sub.remove()
    }
  }, [store, runtime, requestedRunning])
}

export { handleForegroundActive, runServerUntilStopped, useBackgroundServerDaemon }
