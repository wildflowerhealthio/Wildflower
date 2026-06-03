/* oxlint-disable import/max-dependencies -- this is the platform entry point that wires every slice's
   node-side Layer + store + telemetry into `WildflowerServerLive`; consolidating into fewer files
   would hide the wiring rather than tame it. */
import './instrument.ts'
import { createServer } from 'node:http'
import { HttpServer } from '@effect/platform'
import { NodeFileSystem, NodeHttpServer, NodePath, NodeRuntime } from '@effect/platform-node'
import { AppsStore } from 'apps-core/livestore'
import { CollectorStore } from 'collector-core/livestore'
import { Cause, Duration, Effect, Layer } from 'effect'
import { EmrStore } from 'emr-core/livestore'
import { mintHostOwnerToken, seedFirstPartyClient, seedSigningKey } from 'gatekeeper-core/contexts'
import { GatekeeperStore } from 'gatekeeper-core/livestore'
import { cryptoRandomLayerFromWebCrypto } from 'kitchen-sink/crypto-random'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { isLoopbackBindHost } from 'navigation-core'
import { nodeTelemetryLayerFromEnv } from 'telemetry-node'
import { OriginFromTunnelStore } from 'tunnel-core/contexts'
import { TunnelStore } from 'tunnel-core/livestore'
import { TunnelDaemon as NodeTunnelDaemon } from 'tunnel-node'
import { webAssetsDir } from 'wildflower-react/web-assets'
import { WebAssetsDir, WildflowerServerLive } from 'wildflower-server'
import { createStore } from './livestore-store.ts'
import { SERVICE_NAME } from './service-name.ts'
// Config

const PORT = Number(process.env['PORT'] ?? 3000)
const HOSTNAME = process.env['HOSTNAME'] ?? '127.0.0.1'
const IS_DEV = process.env['NODE_ENV'] !== 'production'

// Bootstrap-token issuer/audience: pinned to loopback. The listener
// binds loopback-only (the `isLoopbackBindHost(HOSTNAME)` guard in `run`
// refuses any non-loopback bind), so this origin always matches the
// interface we actually serve on.
// Pairs with the verifier's `requestOriginFromHttpRequest` — the token
// only validates when the caller actually hits the server over
// loopback, so a leaked bootstrap token can't be used against the
// public tunnel URL.
const LOOPBACK_ORIGIN = `http://127.0.0.1:${PORT}`

// Platform dependent layer setup

const CryptoRandomLive = cryptoRandomLayerFromWebCrypto(globalThis.crypto)

const TelemetryLive = nodeTelemetryLayerFromEnv({
  otel: { serviceName: SERVICE_NAME },
})

const run = Effect.gen(function* () {
  // Fail loud before any work if the configured bind host would expose
  // the listener beyond loopback. The app-layer `loopbackGateMiddleware`
  // (in `wildflower-server`) rejects non-loopback peers per request, but
  // here we refuse to even open a non-loopback socket — belt and braces.
  // `127.x`, `::1`, and `localhost` are accepted; `0.0.0.0`, `::`, a LAN
  // IP, or a public hostname die here at startup.
  if (!isLoopbackBindHost(HOSTNAME)) {
    return yield* Effect.dieMessage(
      `Refusing to bind wildflower-node to non-loopback HOSTNAME=${HOSTNAME}; only loopback hosts (127.x, ::1, localhost) are permitted.`
    )
  }

  const store = yield* Effect.promise(() => createStore())
  const gatekeeperStoreLayer = GatekeeperStore.layerFrom(store)
  const localHttpServerStoreLayer = LocalHttpServerStore.layerFrom(store)
  const tunnelStoreLayer = TunnelStore.layerFrom(store)
  const originLayer = OriginFromTunnelStore.pipe(
    Layer.provide(Layer.mergeAll(tunnelStoreLayer, localHttpServerStoreLayer))
  )

  // Seed the bind target up front. Node has no LHS daemon (uses
  // NodeHttpServer.layer directly), so without this commit the
  // clientDocument default would stay at 127.0.0.1:8080 and
  // servedOrigin$ would lie. `running: true` waits for the actual bind
  // — see `afterStartupEffect` below.
  yield* Effect.sync(() =>
    store.commit(
      ServerState.events.localHttpServerStateSet({
        localHostname: HOSTNAME,
        port: PORT,
      })
    )
  )

  // Idempotent: signing key + first-party `wildflower-host` client identity.
  yield* seedSigningKey.pipe(Effect.provide(gatekeeperStoreLayer))
  yield* seedFirstPartyClient.pipe(Effect.provide(gatekeeperStoreLayer))

  // Dev only: mint a bootstrap token; prod uses the device flow.
  const bootstrapToken: string | null = IS_DEV
    ? yield* mintHostOwnerToken({ origin: LOOPBACK_ORIGIN, ttl: Duration.hours(1) }).pipe(
        Effect.provide(gatekeeperStoreLayer),
        Effect.catchAllCause((cause) =>
          Effect.as(Effect.logError('Bootstrap token unavailable.', Cause.pretty(cause)), null)
        )
      )
    : null

  // Runs once `Layer.tap` fires after the HTTP server actually binds.
  // Flips `ServerState.running = true` (so `servedOrigin$` stops
  // reporting the idle default for any concurrent reader), then —
  // in dev — prints the bootstrap link with the pinned loopback origin
  // (matching what the bootstrap token's `iss` was minted against).
  const afterStartupEffect: Effect.Effect<void, never> = Effect.gen(function* () {
    yield* Effect.sync(() =>
      store.commit(ServerState.events.localHttpServerStateSet({ running: true }))
    )
    if (bootstrapToken !== null) {
      yield* Effect.logInfo(
        `Bootstrap: ${LOOPBACK_ORIGIN}/home?token=${encodeURIComponent(bootstrapToken)}`
      )
    }
  })

  // `Layer.mergeAll` runs the HTTP server and the tunnel daemon side
  // by side under the same scope — `Layer.launch` keeps both alive until
  // the process is interrupted. `apps-core`'s `LaunchApp` reads
  // `TunnelStore` + `LocalHttpServerStore` directly to decide tunnel vs
  // local-origin redirects; the old `TunnelControl` Tag is gone.
  const FullServerLive = Layer.mergeAll(WildflowerServerLive, NodeTunnelDaemon).pipe(
    HttpServer.withLogAddress,
    Layer.tap(() => afterStartupEffect),
    Layer.provide(
      Layer.mergeAll(
        tunnelStoreLayer,
        EmrStore.layerFrom(store),
        AppsStore.layerFrom(store),
        gatekeeperStoreLayer,
        localHttpServerStoreLayer,
        CollectorStore.layerFrom(store),
        CryptoRandomLive,
        NodeHttpServer.layer(createServer, { port: PORT, host: HOSTNAME }),
        NodeFileSystem.layer,
        NodePath.layer,
        Layer.succeed(WebAssetsDir, webAssetsDir),
        originLayer,
        TelemetryLive
      )
    )
  )

  yield* Layer.launch(FullServerLive)
})

NodeRuntime.runMain(run)
