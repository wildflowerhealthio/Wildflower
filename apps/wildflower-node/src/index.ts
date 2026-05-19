/* oxlint-disable import/max-dependencies -- this is the platform entry point that wires every slice's
   node-side Layer + store + telemetry into `WildflowerServerLive`; consolidating into fewer files
   would hide the wiring rather than tame it. */
import './instrument.ts'
import { createServer } from 'node:http'
import { HttpServer } from '@effect/platform'
import { NodeFileSystem, NodeHttpServer, NodePath, NodeRuntime } from '@effect/platform-node'
import { AppsStore } from 'apps-core/livestore'
import { CollectorStore } from 'collector-core/livestore'
import { Duration, Effect, Layer } from 'effect'
import { EmrStore } from 'emr-core/livestore'
import { mintHostOwnerToken, seedFirstPartyClient, seedSigningKey } from 'gatekeeper-core/contexts'
import { GatekeeperStore } from 'gatekeeper-core/livestore'
import { cryptoRandomLayerFromWebCrypto } from 'kitchen-sink/crypto-random'
import { StringLiteralTypes } from 'kitchen-sink/types'
import { LocalHttpServerStore } from 'local-http-server-core/livestore'
import { Origin } from 'navigation-core'
import { nodeTelemetryLayerFromEnv } from 'telemetry-node'
import { TunnelStore } from 'tunnel-core/livestore'
import { TunnelDaemon as NodeTunnelDaemon } from 'tunnel-node'
import { webAssetsDir } from 'wildflower-react/web-assets'
import { WebAssetsDir, WildflowerServerLive } from 'wildflower-server'
import { createStore } from './livestore-store.ts'
import { SERVICE_NAME } from './service-name.ts'

// Config

const PORT = Number(process.env['PORT'] ?? 3000)
const ORIGIN = process.env['ORIGIN'] ?? `http://localhost:${PORT}`
if (!StringLiteralTypes.endsWithAlphanumericCharacter(ORIGIN)) {
  throw new Error(`Invalid origin: ${ORIGIN}`)
}
const IS_DEV = process.env['NODE_ENV'] !== 'production'

// Platform dependent layer setup

const CryptoRandomLive = cryptoRandomLayerFromWebCrypto(globalThis.crypto)

const TelemetryLive = nodeTelemetryLayerFromEnv({
  otel: { serviceName: SERVICE_NAME },
})

const run = Effect.gen(function* () {
  const store = yield* Effect.promise(() => createStore())
  const gatekeeperStoreLayer = GatekeeperStore.layerFrom(store)
  const localHttpServerStoreLayer = LocalHttpServerStore.layerFrom(store)
  const originLayer = Layer.succeed(Origin, ORIGIN)

  // Idempotent: signing key + first-party `wildflower-host` client identity.
  yield* seedSigningKey.pipe(Effect.provide(gatekeeperStoreLayer))
  yield* seedFirstPartyClient.pipe(Effect.provide(gatekeeperStoreLayer))

  // Dev only: mint a bootstrap token; prod uses the device flow.
  let bootstrapToken: string | null = null
  if (IS_DEV) {
    bootstrapToken = yield* mintHostOwnerToken({ ttl: Duration.hours(1) }).pipe(
      Effect.provide(gatekeeperStoreLayer),
      Effect.provide(originLayer),
      Effect.catchAll((err) =>
        Effect.as(Effect.logError('Bootstrap token unavailable.', err), null)
      )
    )
  }

  // `Layer.tap` after `afterStartupEffect` emits this once the port is bound.
  let afterStartupEffect = Effect.void
  if (bootstrapToken != null) {
    afterStartupEffect = Effect.logInfo(
      `Bootstrap: ${ORIGIN}/gatekeeper?token=${encodeURIComponent(bootstrapToken)}`
    )
  }

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
        TunnelStore.layerFrom(store),
        EmrStore.layerFrom(store),
        AppsStore.layerFrom(store),
        gatekeeperStoreLayer,
        localHttpServerStoreLayer,
        CollectorStore.layerFrom(store),
        CryptoRandomLive,
        NodeHttpServer.layer(createServer, { port: PORT }),
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
