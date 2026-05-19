/* oxlint-disable import/max-dependencies -- this is the platform entry point that wires every slice's
   node-side Layer + store + telemetry into `WildflowerServerLive`; consolidating into fewer files
   would hide the wiring rather than tame it. */
import './instrument.ts'
import { createServer } from 'node:http'
import { HttpServer } from '@effect/platform'
import { NodeFileSystem, NodeHttpServer, NodePath, NodeRuntime } from '@effect/platform-node'
import type { ServerState } from 'apps-core/contexts'
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
import { runTunnelDaemon } from 'tunnel-core/daemon'
import { TunnelStore } from 'tunnel-core/livestore'
import { startTunnel } from 'tunnel-node'
import { webAssetsDir } from 'wildflower-react/web-assets'
import { WebAssetsDir, WildflowerServerLive } from 'wildflower-server'
import { createStore } from './livestore-store.ts'
import { SERVICE_NAME } from './service-name.ts'
import { TunnelControlLive } from './tunnel-control.ts'

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
  const tunnelStoreLayer = TunnelStore.layerFrom(store)
  const localHttpServerStoreLayer = LocalHttpServerStore.layerFrom(store)
  const originLayer = Layer.succeed(Origin, ORIGIN)

  // Tunnel daemon: long-lived fiber that drives `TunnelConfig` →
  // `tunnel-node`'s `startTunnel` → `TunnelState`. `Layer.scopedDiscard`
  // ties the daemon's lifetime to the `WildflowerServerLive` scope; the
  // daemon's own error channel is `never` (failures are persisted into
  // `TunnelState.error` rather than thrown), so the surrounding
  // `Layer.launch` doesn't see them.
  const TunnelDaemonLive = Layer.scopedDiscard(
    Effect.forkScoped(runTunnelDaemon(startTunnel))
  ).pipe(Layer.provide(tunnelStoreLayer))

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

  // `apps-core`'s `TunnelControl` returns a static `ServerState`; on the
  // node host there is no tunnel, so `tunnelActive` is `false` at start
  // and `setTunnelActive` fails. Mobile hosts swap in their own Live.
  const serverState: ServerState = {
    origin: ORIGIN,
    localOrigin: ORIGIN,
    port: PORT,
    tunnelActive: false,
  }

  // `Layer.mergeAll` runs the HTTP server and the tunnel daemon side
  // by side under the same scope — `Layer.launch` keeps both alive until
  // the process is interrupted. The daemon is provided its own
  // `TunnelStore` layer inline (closed over above); the rest of the
  // platform deps shared with `WildflowerServerLive` are provided here.
  // `LocalHttpServerStore` isn't consumed yet on the node host (PR C
  // rewires `apps-core` to read tunnel/server state from livestore), but
  // its layer is wired here so the materializers in `schema.ts` have a
  // home and the daemon-on-Streams pattern is ready for the next PR.
  const FullServerLive = Layer.mergeAll(WildflowerServerLive, TunnelDaemonLive).pipe(
    HttpServer.withLogAddress,
    Layer.tap(() => afterStartupEffect),
    Layer.provide(EmrStore.layerFrom(store)),
    Layer.provide(AppsStore.layerFrom(store)),
    Layer.provide(TunnelControlLive(serverState)),
    Layer.provide(gatekeeperStoreLayer),
    Layer.provide(localHttpServerStoreLayer),
    Layer.provide(CollectorStore.layerFrom(store)),
    Layer.provide(CryptoRandomLive),
    Layer.provide(NodeHttpServer.layer(createServer, { port: PORT })),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
    Layer.provide(Layer.succeed(WebAssetsDir, webAssetsDir)),
    Layer.provide(originLayer),
    Layer.provide(TelemetryLive)
  )

  yield* Layer.launch(FullServerLive)
})

NodeRuntime.runMain(run)
