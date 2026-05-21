/* oxlint-disable import/max-dependencies -- on-device platform entry; mirrors wildflower-node by
   wiring every slice's expo-side Layer + store + telemetry into WildflowerServerLive. */
import { HttpServer } from '@effect/platform'
import type { Store } from '@livestore/livestore'
import { AppsStore } from 'apps-core/livestore'
import { CollectorStore } from 'collector-core/livestore'
import { Cause, Duration, Effect, Layer, type Scope, Stream } from 'effect'
import { EmrStore } from 'emr-core/livestore'
import { ExpoContext, ExpoHttpServer } from 'expo-effect-platform'
import { Directory, File, Paths } from 'expo-file-system'
import { mintHostOwnerToken, seedFirstPartyClient, seedSigningKey } from 'gatekeeper-core/contexts'
import { BootstrapToken, GatekeeperStore } from 'gatekeeper-core/livestore'
import { cryptoRandomLayerFromWebCrypto } from 'kitchen-sink/crypto-random'
import { runHttpServerDaemon } from 'local-http-server-core/daemon'
import { LocalHttpServerStore } from 'local-http-server-core/livestore'
import { Origin } from 'navigation-core'
import { injectActiveOtelContext, reactNativeTelemetryLayerFromEnv } from 'telemetry-react-native'
import { TunnelStore } from 'tunnel-core/livestore'
import { html as embeddableHtml } from 'wildflower-react/embeddable-html'
import { WebAssetsDir, WildflowerServerLive } from 'wildflower-server'
import { PORT, SERVICE_NAME } from '../constants.ts'
import { WildflowerStore } from '../livestore/livestore-store.ts'
import type { schema } from '../livestore/schema.ts'

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

const LOCAL_HOSTNAME = `127.0.0.1`

type BootstrapOutput = {
  readonly store: Store<typeof schema, object>
  readonly webAssetsDir: string
  readonly gatekeeperStoreLayer: ReturnType<typeof GatekeeperStore.layerFrom>
  readonly tunnelStoreLayer: ReturnType<typeof TunnelStore.layerFrom>
  readonly localHttpServerStoreLayer: ReturnType<typeof LocalHttpServerStore.layerFrom>
}

/**
 * One-shot bootstrap: telemetry injection, signing-key seed,
 * first-party client seed, asset staging, host-owner token mint.
 *
 * Runs exactly once when {@link HttpServerDaemonLive} is built, before
 * the watcher forks. Everything it produces (store-layer factories,
 * the staged asset path) is closed over by the watcher's `startServer`
 * closure, so a daemon respawn (port change, requestedRunning toggle)
 * does not re-run the seeds or re-mint the token.
 *
 * If `mintHostOwnerToken` fails the bootstrap continues — the device
 * falls back to the device-code flow on next launch — but no token row
 * is written.
 */
const bootstrapOnce: Effect.Effect<BootstrapOutput, never, WildflowerStore> = Effect.gen(
  function* () {
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
    // The Origin bound here pins the JWT issuer / audience claim to the
    // loopback URL; runtime port reassignment would invalidate the
    // token (see Composition Explanation).
    const bootstrapToken = yield* mintHostOwnerToken({ ttl: Duration.hours(24) }).pipe(
      Effect.provide(gatekeeperStoreLayer),
      Effect.provide(
        Layer.succeed(
          Origin,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          `http://${LOCAL_HOSTNAME}:${PORT}` as unknown as typeof Origin.Service
        )
      ),
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
      yield* Effect.sync(() =>
        store.commit(BootstrapToken.events.bootstrapTokenSet({ token: bootstrapToken }))
      )
      yield* Effect.logInfo(`Bootstrap token minted (prefix: ${bootstrapToken.slice(0, 8)}…)`)
    }

    return {
      store,
      webAssetsDir,
      gatekeeperStoreLayer,
      tunnelStoreLayer,
      localHttpServerStoreLayer,
    }
  }
)

/**
 * Build the per-bind `startServer` closure handed to
 * `runHttpServerDaemon`. Each invocation is the daemon's response to a
 * `StartOrReconfigure` intent — port / hostname are the live values
 * from `ServerState`.
 */
const makeStartServer =
  ({
    store,
    gatekeeperStoreLayer,
    tunnelStoreLayer,
    localHttpServerStoreLayer,
    webAssetsDir,
  }: BootstrapOutput) =>
  ({
    port,
    hostname,
  }: {
    port: number
    hostname: string
  }): Stream.Stream<void, never, Scope.Scope> =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        const CryptoRandomLive = cryptoRandomLayerFromWebCrypto(globalThis.crypto)
        const TelemetryLive = reactNativeTelemetryLayerFromEnv({
          otel: { serviceName: SERVICE_NAME },
        })

        // Mirror `apps/wildflower-node`: union all deps into a single
        // `Layer.mergeAll` and provide it once. `ExpoContext.layer`
        // bundles `FileSystem` + `Path` + `HttpPlatform` + `Etag.Generator`.
        const ServerDeps = Layer.mergeAll(
          // Slice store projections.
          EmrStore.layerFrom(store),
          AppsStore.layerFrom(store),
          CollectorStore.layerFrom(store),
          gatekeeperStoreLayer,
          tunnelStoreLayer,
          localHttpServerStoreLayer,
          // Cross-cutting platform services.
          CryptoRandomLive,
          // HTTP transport + static-asset peers.
          ExpoHttpServer.layer({ port, hostname }),
          ExpoContext.layer,
          Layer.succeed(WebAssetsDir, webAssetsDir),
          Layer.succeed(
            Origin,
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            `http://${LOCAL_HOSTNAME}:${port}` as unknown as typeof Origin.Service
          ),
          TelemetryLive
        )
        const FullServerLive = WildflowerServerLive.pipe(
          HttpServer.withLogAddress,
          Layer.provide(ServerDeps),
          Layer.tapErrorCause((cause) =>
            Effect.logError('[wildflower-expo] FullServerLive cause:\n' + Cause.pretty(cause))
          )
        )
        yield* Layer.build(FullServerLive)
        // First emit = bind signal. `Stream.never` parks the stream
        // until the daemon closes the sub-scope, releasing `Layer.build`'s
        // scoped finalizers (which tears down the HTTP listener).
        return Stream.concat(Stream.succeed(undefined as void), Stream.never)
      }).pipe(Effect.orDie)
    )

/**
 * On-device HTTP-server daemon Layer.
 *
 * Layer shape mirrors `tunnel-expo`'s `TunnelDaemon` so the two can be
 * `Layer.mergeAll`'d and launched once — the same composition node
 * uses in [`apps/wildflower-node/src/index.ts`](../../../wildflower-node/src/index.ts).
 *
 * `Layer.scopedDiscard` runs the inner Effect once when the Layer is
 * built. {@link bootstrapOnce} runs in that opening, before the
 * watcher fiber is forked — so seeds + token mint happen exactly once
 * per Layer build, even as the daemon's internal respawn loop tears
 * down and rebuilds the HTTP listener.
 *
 * `Effect.forkScoped` ties the watcher fiber to the Layer's scope. When
 * the launcher (the `useEffect` in `app-livestore-provider.tsx`) calls
 * `Fiber.interrupt` on the launch fiber, the scope closes and the
 * watcher — together with whatever sub-scope it's currently holding —
 * is torn down cleanly. See
 * [`Composition Explanation`](../../../wildflower-server/docs/Composition%20Explanation.md)
 * for the full layer graph.
 */
const HttpServerDaemonLive: Layer.Layer<never, never, WildflowerStore> = Layer.scopedDiscard(
  Effect.gen(function* () {
    const deps = yield* bootstrapOnce
    yield* Effect.forkScoped(
      runHttpServerDaemon(makeStartServer(deps)).pipe(
        Effect.provide(deps.localHttpServerStoreLayer)
      )
    )
  })
)

export { bootstrapOnce, HttpServerDaemonLive, LOCAL_HOSTNAME }
