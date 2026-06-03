import { FileSystem, HttpServer, Path } from '@effect/platform'
/* oxlint-disable import/max-dependencies -- on-device platform entry; mirrors wildflower-node by
   wiring every slice's expo-side Layer + store + telemetry into WildflowerServerLive. */
import type * as PlatformError from '@effect/platform/Error'
import type { HttpRouter } from '@effect/platform/HttpRouter'
import { AppsStore } from 'apps-core/livestore'
import { CollectorStore } from 'collector-core/livestore'
import { Cause, DefaultServices, Duration, Effect, Layer, type Scope, Stream } from 'effect'
import { EmrStore } from 'emr-core/livestore'
import { ExpoContext, ExpoHttpServer } from 'expo-effect-platform'
import { Paths } from 'expo-file-system'
import { mintHostOwnerToken, seedFirstPartyClient, seedSigningKey } from 'gatekeeper-core/contexts'
import { GatekeeperStore, LocalClientToken } from 'gatekeeper-core/livestore'
import { type CryptoRandom, cryptoRandomLayerFromWebCrypto } from 'kitchen-sink/crypto-random'
import { runHttpServerDaemon } from 'local-http-server-core/daemon'
import { LocalHttpServerStore } from 'local-http-server-core/livestore'
import { injectActiveOtelContext, reactNativeTelemetryLayerFromEnv } from 'telemetry-react-native'
import { OriginFromTunnelStore } from 'tunnel-core/contexts'
import { TunnelStore } from 'tunnel-core/livestore'
import { html as embeddableHtml } from 'wildflower-react/single-web-html'
import { WebAssetsDir, WildflowerServerLive } from 'wildflower-server'
import { SERVICE_NAME } from '../constants.ts'
import { WildflowerStore } from '../livestore/livestore-store.ts'

/**
 * Stage the SPA's inlined HTML on disk so `StaticSpaLive` can serve it
 * via `HttpServerResponse.file()` (Expo's `HttpPlatform` hands the path
 * to native; bytes never cross the JS bridge). Idempotent — the
 * cache-dir lifecycle is opaque to the OS, so we always (re)write on
 * boot to pick up rebuilds.
 *
 * Routed through the Expo-backed `FileSystem.FileSystem` (provided by
 * {@link ExpoContext.layer}) so each filesystem step lands in the
 * Effect trace under the surrounding Layer's scope and failures are
 * typed. `Paths.cache.uri` is the only cache-directory consumer in this
 * project, so it's resolved inline rather than threaded through a tag.
 */
const stageWebAssetsDir: Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  // `Path.Path` resolvers don't accept the `file://` URI scheme — strip it.
  const cacheDir = Paths.cache.uri.replace(/^file:\/\//, '')
  const dir = path.join(cacheDir, 'wildflower-static')
  yield* fs.makeDirectory(dir, { recursive: true })
  const indexFile = path.join(dir, 'index.html')
  yield* fs.writeFileString(indexFile, embeddableHtml)
  return dir
})

const CryptoRandomLive = cryptoRandomLayerFromWebCrypto(globalThis.crypto)
const TelemetryLive = reactNativeTelemetryLayerFromEnv({ otel: { serviceName: SERVICE_NAME } })

/**
 * Six slice-store projections of the singleton wildflower {@link
 * WildflowerStore}. Each slice's `Tag` resolves to the same underlying
 * `Store` handle — building these from separate stores would split the
 * database into six.
 */
const SliceStoresLive: Layer.Layer<
  AppsStore | CollectorStore | EmrStore | GatekeeperStore | LocalHttpServerStore | TunnelStore,
  never,
  WildflowerStore
> = Layer.unwrapEffect(
  Effect.map(WildflowerStore, (store) =>
    Layer.mergeAll(
      EmrStore.layerFrom(store),
      AppsStore.layerFrom(store),
      CollectorStore.layerFrom(store),
      GatekeeperStore.layerFrom(store),
      TunnelStore.layerFrom(store),
      LocalHttpServerStore.layerFrom(store)
    )
  )
)

/**
 * Static peer context the HTTP-server daemon hands to each per-bind
 * {@link makeBindLive} build:
 *
 *  - The six {@link SliceStoresLive} projections.
 *  - Cross-cutting platform layers (crypto, telemetry, `ExpoContext`).
 *  - `WebAssetsDir`, produced by the anonymous `Layer.effect(...)` body
 *    below — which also runs the one-shot bootstrap: telemetry-OTel
 *    inject, signing-key seed, first-party client seed, and host-owner
 *    token mint. The minted token is committed into the queryable
 *    `LocalClientToken` row so `HomeScreen` can pick it up via
 *    `useQuery` and hand it to `<AppShellWebView>`.
 *
 * Layer-cached: the bootstrap effect runs exactly once when this Layer
 * is built (memoized by Effect), regardless of how many times the
 * daemon's inner watcher loop respawns a sub-server.
 */
const HttpServerContextLive = Layer.mergeAll(
  Layer.effect(
    WebAssetsDir,
    Effect.gen(function* () {
      const store = yield* WildflowerStore
      // Wrap the store's `query`/`commit`/`subscribe` so Livestore spans
      // attach to the currently-active OTel context (e.g. the per-request
      // HTTP-server span). Idempotent on repeat calls.
      injectActiveOtelContext(store)

      // Seed signing key + first-party `wildflower-host` client (both
      // idempotent; the gatekeeper-core contexts no-op on repeat).
      yield* seedSigningKey
      yield* seedFirstPartyClient

      // Mint the local-client bootstrap token. On Expo the device IS the
      // owner — there's no separate developer minting it via a dev log.
      // `OriginFromTunnelStore` reads the live origin from
      // `servedOrigin$` (tunnel URL when up, LHS-bound loopback otherwise);
      // at boot the tunnel isn't running and LHS state is at clientDocument
      // defaults so the JWT iss/aud is `http://127.0.0.1:8080`.
      const token = yield* mintHostOwnerToken({ ttl: Duration.hours(24) }).pipe(
        Effect.provide(OriginFromTunnelStore),
        Effect.catchAllCause((cause) =>
          Effect.as(Effect.logError('Local client token unavailable.', Cause.pretty(cause)), null)
        )
      )
      if (token !== null) {
        yield* Effect.sync(() =>
          store.commit(LocalClientToken.events.localClientTokenSet({ value: token }))
        )
        yield* Effect.logInfo(`Local client token minted (prefix: ${token.slice(0, 8)}…)`)
      }

      return yield* stageWebAssetsDir
    })
  ).pipe(Layer.provideMerge(ExpoContext.layer)),
  CryptoRandomLive,
  TelemetryLive
).pipe(Layer.provideMerge(SliceStoresLive))

/**
 * Per-bind Layer constructor consumed by {@link startServer}: composes
 * `WildflowerServerLive` against the bind-specific `ExpoHttpServer`
 * binding + `Origin`. Static peers (slice stores, telemetry, crypto,
 * etc.) flow in from {@link HttpServerContextLive} on the daemon's
 * outer scope.
 *
 * `OriginFromTunnelStore` reads the live origin from `servedOrigin$`
 * (tunnel URL when running, LHS-bound loopback otherwise) — so the
 * `Origin` consumers (gatekeeper JWT audience, FHIR bundle URLs)
 * automatically follow tunnel toggles without rebuilding this Layer.
 *
 * `Layer.succeedContext(DefaultServices.liveServices)` is appended to
 * the pipe to absorb the `DefaultServices` (Clock/Console/Random/
 * ConfigProvider/Tracer) requirement that the inner Effect operations
 * pull into `R`. The Effect runtime auto-provides these at fiber
 * start, but the static type still tracks them; injecting the live
 * services here keeps `makeBindLive`'s residual `R` to just the
 * domain tags so the inferred shape stays writeable.
 */
const makeBindLive = ({
  port,
  hostname,
}: {
  port: number
  hostname: string
}): Layer.Layer<
  never,
  never,
  | AppsStore
  | CollectorStore
  | EmrStore
  | GatekeeperStore
  | LocalHttpServerStore
  | TunnelStore
  | CryptoRandom
  | WebAssetsDir
  | HttpRouter.DefaultServices
> =>
  WildflowerServerLive.pipe(
    HttpServer.withLogAddress,
    // `stopTimeoutSeconds: 0.5` keeps the listener-release inside the
    // background-server's overall teardown budget (`TEARDOWN_TIMEOUT` in
    // `background-server.ts`). The default 5s would consume the entire iOS
    // expiration grace window for drain, leaving the foreground service
    // stuck in `isRunning() === true` and blocking the foreground-resume
    // recovery path that re-enters `reconcile` from `AppState 'active'`.
    Layer.provide(
      Layer.mergeAll(
        ExpoHttpServer.layer({ port, hostname, stopTimeoutSeconds: 0.5 }),
        OriginFromTunnelStore
      )
    ),
    Layer.provide(Layer.succeedContext(DefaultServices.liveServices)),
    Layer.tapErrorCause((cause) =>
      Effect.logError('[wildflower-expo] FullServerLive cause:\n' + Cause.pretty(cause))
    )
  )

/**
 * On-device HTTP-server daemon Layer.
 *
 * Shape mirrors `tunnel-expo`'s `TunnelDaemon` so the two can be
 * `Layer.mergeAll`'d and launched once — the same composition node
 * uses in [`apps/wildflower-node/src/index.ts`](../../../wildflower-node/src/index.ts).
 *
 * `Layer.scopedDiscard` runs the inner Effect once when the Layer is
 * built. `Layer.build` runs the bootstrap (seeds + mint) at that
 * point, then `Layer.succeedContext` rewraps the resulting `Context`
 * as a requirement-less Layer that the respawn loop provides into
 * each per-bind build — so the bootstrap runs exactly once before the
 * watcher fiber is forked, and the daemon's respawn loop
 * (`runHttpServerDaemon`'s `executeIntents`) only rebuilds the
 * per-bind layer; bootstrap is not re-entered.
 *
 * `Effect.forkScoped` ties the watcher fiber to the Layer's scope.
 * When the launcher (the `useEffect` in `app-runtime-provider.tsx`)
 * calls `Fiber.interrupt` on the launch fiber, the scope closes and
 * the watcher — together with whatever sub-scope it's currently
 * holding — is torn down cleanly. See
 * [`Composition Explanation`](../../../wildflower-server/docs/Composition%20Explanation.md)
 * for the full layer graph.
 */
const HttpServerDaemonLive: Layer.Layer<never, PlatformError.PlatformError, WildflowerStore> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      // Build the static peer context once and freeze it as a
      // requirement-less Layer for downstream `Layer.provide`s.
      // `Layer.build` runs the bootstrap (seeds + mint) here, before
      // the watcher fiber forks; `Layer.succeedContext` re-wraps the
      // built Context so the daemon's respawn loop reuses the same
      // built tags without re-entering bootstrap.
      const httpServerContext = Layer.succeedContext(yield* Layer.build(HttpServerContextLive))
      const startServer = (cfg: {
        port: number
        hostname: string
      }): Stream.Stream<void, never, Scope.Scope> =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            // Bracket the listener bind so the shutdown trace makes it
            // obvious when the HTTP listener actually goes away. Finalizers
            // run LIFO, so the "released" finalizer is registered *before*
            // `Layer.build` (runs last, after the listener has closed) and
            // the "releasing" finalizer *after* `Layer.build` (runs first,
            // before the listener closes). `closeStartMs` is captured at
            // "releasing" time and read at "released" time to log elapsed
            // close duration — invaluable when diagnosing slow shutdowns.
            yield* Effect.logInfo(`HTTP listener binding on ${cfg.hostname}:${cfg.port}`)
            const bindStart = yield* Effect.sync(() => Date.now())
            const closeTiming: { startMs: number } = { startMs: 0 }
            yield* Effect.addFinalizer(() =>
              Effect.logInfo(
                `HTTP listener released (${cfg.hostname}:${cfg.port}) in ${Date.now() - closeTiming.startMs}ms`
              )
            )
            yield* Layer.build(makeBindLive(cfg).pipe(Layer.provide(httpServerContext)))
            yield* Effect.logInfo(
              `HTTP listener bound on ${cfg.hostname}:${cfg.port} in ${Date.now() - bindStart}ms`
            )
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closeTiming.startMs = Date.now()
              }).pipe(
                Effect.zipRight(
                  Effect.logInfo(`HTTP listener releasing (${cfg.hostname}:${cfg.port})`)
                )
              )
            )
            // First emit = bind signal. `Stream.never` parks the stream
            // until the daemon closes the sub-scope, releasing
            // `Layer.build`'s scoped finalizers (which tears down the
            // HTTP listener).
            return Stream.concat(Stream.succeed(undefined as void), Stream.never)
          }).pipe(Effect.orDie)
        )
      yield* Effect.forkScoped(
        runHttpServerDaemon(startServer).pipe(Effect.provide(httpServerContext))
      )
    })
  )

export { HttpServerDaemonLive }
