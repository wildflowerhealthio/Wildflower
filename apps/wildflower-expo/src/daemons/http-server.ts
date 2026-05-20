/* oxlint-disable import/max-dependencies -- on-device platform entry; mirrors wildflower-node by
   wiring every slice's expo-side Layer + store + telemetry into WildflowerServerLive. */
import { HttpServer } from '@effect/platform'
import { AppsStore } from 'apps-core/livestore'
import { CollectorStore } from 'collector-core/livestore'
import { Cause, Duration, Effect, Layer, type Scope } from 'effect'
import { EmrStore } from 'emr-core/livestore'
import { ExpoContext, ExpoHttpServer } from 'expo-effect-platform'
import { Directory, File, Paths } from 'expo-file-system'
import { mintHostOwnerToken, seedFirstPartyClient, seedSigningKey } from 'gatekeeper-core/contexts'
import { GatekeeperStore } from 'gatekeeper-core/livestore'
import { cryptoRandomLayerFromWebCrypto } from 'kitchen-sink/crypto-random'
import { runHttpServerDaemon } from 'local-http-server-core/daemon'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { Origin } from 'navigation-core'
import { injectActiveOtelContext, reactNativeTelemetryLayerFromEnv } from 'telemetry-react-native'
import { PublicOrigin } from 'tunnel-core/contexts'
import { TunnelState, TunnelStore } from 'tunnel-core/livestore'
import { html as embeddableHtml } from 'wildflower-react/embeddable-html'
import { WebAssetsDir, WildflowerServerLive } from 'wildflower-server'
import { PORT, SERVICE_NAME } from '../constants.ts'
import { WildflowerStore } from '../livestore/livestore-store.ts'

/**
 * Stage the SPA's inlined HTML on disk so `StaticSpaLive` can serve it
 * via `HttpServerResponse.file()` (Expo's `HttpPlatform` hands the path
 * to native; bytes never cross the JS bridge). Idempotent — the
 * cache-dir lifecycle is opaque to the OS, so we always (re)write on
 * boot to pick up rebuilds.
 */
const stageWebAssetsDir = (): string => {
  const dir = new Directory(Paths.cache, 'wildflower-static')
  dir.create({ intermediates: true, idempotent: true })
  const indexFile = new File(dir, 'index.html')
  if (indexFile.exists) indexFile.delete()
  indexFile.create()
  indexFile.write(embeddableHtml)
  // `Path.Path` resolvers don't accept the `file://` URI scheme — strip it.
  return dir.uri.replace(/^file:\/\//, '')
}

const LOCAL_ORIGIN = `http://127.0.0.1:${PORT}`

/**
 * On-device server daemon. Composes the same `WildflowerServerLive`
 * graph as `apps/wildflower-node/src/index.ts` (gatekeeper seeds, store
 * layers, telemetry, web assets, `ExpoHttpServer.layer`), then hands
 * a `startServer(port, localOrigin)` callback to `runHttpServerDaemon`
 * from `local-http-server-core/daemon`. That daemon watches
 * `LocalHttpServerStore.requestedRunning` and forks / tears down the
 * server fiber to match; the store also gets
 * `{ running, port, localOrigin }` written as a side-effect of
 * bind/teardown.
 *
 * `Origin` is bound to the loopback URL (per the user-approved
 * isolation design). Anything that needs the public URL reads
 * `PublicOrigin.get` — backed here by a live read of
 * `TunnelStore.currentPublicOrigin`, falling back to `LOCAL_ORIGIN`.
 *
 * Mirrors `apps/wildflower-node/src/index.ts` section-for-section. See
 * [`Composition Explanation`](../../../wildflower-server/docs/Composition%20Explanation.md)
 * for the full layer graph; the `// 1.` … `// 7.` comments below
 * mirror that doc.
 */
const httpServerDaemon = (): Effect.Effect<void, never, Scope.Scope | WildflowerStore> =>
  Effect.gen(function* () {
    const store = yield* WildflowerStore
    // 1. Wrap the store's `query`/`commit`/`subscribe` so Livestore spans
    // attach to the currently-active OTel context (e.g. the per-request
    // HTTP-server span). Idempotent on repeat calls.
    injectActiveOtelContext(store)

    // 2. Build the gatekeeper / slice store layers (all projections of `store`).
    const gatekeeperStoreLayer = GatekeeperStore.layerFrom(store)
    const tunnelStoreLayer = TunnelStore.layerFrom(store)
    const localHttpServerStoreLayer = LocalHttpServerStore.layerFrom(store)

    // Stage the inlined SPA so StaticSpaLive has a real on-disk index.
    const webAssetsDir = yield* Effect.sync(stageWebAssetsDir)

    // 3. + 4. Seed signing key + first-party `wildflower-host` client.
    yield* seedSigningKey.pipe(Effect.provide(gatekeeperStoreLayer))
    yield* seedFirstPartyClient.pipe(Effect.provide(gatekeeperStoreLayer))

    // 5. Mint a host-owner bootstrap token. On Expo the device IS the
    // owner — there's no separate developer minting it via a dev log.
    const bootstrapToken = yield* mintHostOwnerToken({ ttl: Duration.hours(24) }).pipe(
      Effect.provide(gatekeeperStoreLayer),
      Effect.provide(Layer.succeed(Origin, LOCAL_ORIGIN)),
      Effect.catchAll((cause) =>
        Effect.as(
          Effect.logError(
            'Bootstrap token unavailable.',
            cause,
            cause.cause,
            typeof cause.cause === 'object' && cause.cause !== null && 'stack' in cause.cause
              ? cause.cause.stack
              : undefined
          ),
          null
        )
      )
    )
    if (bootstrapToken !== null) {
      yield* Effect.logInfo(
        `Bootstrap token (paste at /gatekeeper?token=): ${bootstrapToken.slice(0, 8)}…`
      )
    }

    const CryptoRandomLive = cryptoRandomLayerFromWebCrypto(globalThis.crypto)
    const TelemetryLive = reactNativeTelemetryLayerFromEnv({
      otel: { serviceName: SERVICE_NAME },
    })

    // PublicOrigin reads currentPublicOrigin live from the store each
    // time it's accessed; falls back to the loopback. apps-core's
    // LaunchApp uses this to compose redirect URLs.
    const PublicOriginLive = Layer.succeed(PublicOrigin, {
      get: Effect.sync(() => {
        const tunnel = store.query(TunnelState.queries.current$)
        const server = store.query(ServerState.queries.current$)
        return tunnel.currentPublicOrigin ?? server.localOrigin ?? LOCAL_ORIGIN
      }),
    })

    // 6. `startServer` Effect that the daemon forks into a sub-scope
    // each time `LocalHttpServerStore.requestedRunning` flips on (and
    // re-forks if `port` / `localOrigin` change). Building the layer
    // binds the listener; once `Layer.build` emits, the daemon takes
    // that as the "ready" signal and commits the live state.
    const startServer = (port: number, _localOrigin: string): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const FullServerLive = WildflowerServerLive.pipe(
          HttpServer.withLogAddress,
          // Slice store projections.
          Layer.provide(EmrStore.layerFrom(store)),
          Layer.provide(AppsStore.layerFrom(store)),
          Layer.provide(CollectorStore.layerFrom(store)),
          Layer.provide(gatekeeperStoreLayer),
          Layer.provide(tunnelStoreLayer),
          Layer.provide(localHttpServerStoreLayer),
          Layer.provide(PublicOriginLive),
          // Cross-cutting platform services.
          Layer.provide(CryptoRandomLive),
          // HTTP transport + static-asset peers. `ExpoContext.layer`
          // bundles `FileSystem` + `Path` + `HttpPlatform` + `Etag.Generator`.
          Layer.provide(ExpoHttpServer.layer({ port })),
          Layer.provide(ExpoContext.layer),
          Layer.provide(Layer.succeed(WebAssetsDir, webAssetsDir)),
          Layer.provide(Layer.succeed(Origin, LOCAL_ORIGIN)),
          Layer.provide(TelemetryLive),
          Layer.tapErrorCause((cause) =>
            Effect.logError('[wildflower-expo] FullServerLive cause:\n' + Cause.pretty(cause))
          )
        )
        yield* Effect.scoped(Layer.build(FullServerLive))
        // Layer.build emits the resolved Context once every scoped
        // resource (including the bound HTTP listener) is acquired.
      }).pipe(Effect.orDie)

    // Hand off to local-http-server-core's daemon. It watches
    // `requestedRunning` and forks/closes `startServer` into a sub-scope
    // as needed; commits `{ running, port, localOrigin }` once bound.
    yield* runHttpServerDaemon(startServer).pipe(Effect.provide(localHttpServerStoreLayer))
  })

export { httpServerDaemon, LOCAL_ORIGIN, LocalHttpServerStore }
