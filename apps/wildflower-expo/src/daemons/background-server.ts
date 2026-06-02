import { Effect, Fiber, Layer } from 'effect'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { useEffect, useMemo } from 'react'
import BackgroundService, { type BackgroundTaskOptions } from 'react-native-background-actions'
import { TunnelStore } from 'tunnel-core/livestore'
import { TunnelDaemon } from 'tunnel-expo'
import { useWildflowerStore, WildflowerStore } from '../livestore/livestore-store.ts'
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
 * The merged on-device daemon launch as a forkable Effect — the same
 * `Layer.mergeAll(HttpServerDaemonLive, TunnelDaemon)` composition that
 * previously ran under `useComponentScopedRunner`, now hoisted here so the
 * background task can fork it. The wildflower store is provided once at the
 * outer layer; the tunnel + LHS slices get their own projections.
 *
 * `Layer.launch` never returns normally — it holds the scope open until the
 * fiber is interrupted, at which point the scoped finalizers (HTTP listener
 * close, `tunnel.close()`) run. `Effect.orDie` collapses the daemon's
 * `PlatformError` channel after logging, matching the prior provider wiring.
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
    Layer.launch,
    Effect.onError((cause) => Effect.logError('HTTP + Tunnel Daemon failed', cause)),
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
 * The background task body: fork the daemon launch, then resolve only once a
 * stop is signalled — at which point the launch fiber is interrupted and its
 * teardown is **awaited** before the returned promise settles, so the HTTP
 * listener and tunnel are fully closed before `react-native-background-actions`
 * tears the service down.
 *
 * Two independent stop cues are honoured: polling `BackgroundService.isRunning()`
 * (covers `stop()` from unmount / `requestedRunning` → false / Android) and the
 * iOS `'expiration'` event — which fires shortly before the OS reclaims the
 * background window and, unlike `stop()`, leaves `isRunning()` reporting `true`.
 * Whichever fires first wins; `finish` is idempotent so the loser is a no-op.
 *
 * Exported for unit testing; production code reaches it via {@link reconcile}.
 */
const runServerUntilStopped = (
  runtime: Effect.Effect<never, never, never>,
  pollIntervalMs: number = STOP_POLL_INTERVAL_MS
): Promise<void> => {
  const fiber = Effect.runFork(runtime)
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      BackgroundService.removeListener('expiration', finish)
      Effect.runPromise(Fiber.interrupt(fiber)).then(
        () => resolve(),
        () => resolve()
      )
    }
    BackgroundService.on('expiration', finish)
    const poll = setInterval(() => {
      if (!BackgroundService.isRunning()) finish()
    }, pollIntervalMs)
  })
}

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
      const runtime = activeRuntime
      await BackgroundService.start(() => runServerUntilStopped(runtime), SERVER_BACKGROUND_OPTIONS)
    } else if (!desiredRunning && BackgroundService.isRunning()) {
      await BackgroundService.stop()
    }
  })
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
 *    {@link runServerUntilStopped}.
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
}

export { runServerUntilStopped, useBackgroundServerDaemon }
