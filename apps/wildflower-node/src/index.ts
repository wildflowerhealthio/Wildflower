/* oxlint-disable import/max-dependencies -- this is the platform entry point that wires every slice's
   node-side Layer + store + telemetry into `WildflowerServerLive`; consolidating into fewer files
   would hide the wiring rather than tame it. */

/**
 * Node host for `WildflowerServerLive`. The canonical reference for
 * how a platform host composes the cross-platform server Layer.
 *
 * @remarks
 * See [`Composition Explanation`](../../wildflower-server/docs/Composition%20Explanation.md)
 * for the requirements table, the layer graph, and the boot-sequence
 * rationale. The `// 1.` … `// 7.` comments below correspond to that
 * doc's boot-sequence section. The Expo host (`apps/wildflower-expo`)
 * mirrors this file section-for-section with Expo Lives.
 */

import './instrument.ts'
import { createServer } from 'node:http'
import { HttpServer } from '@effect/platform'
import { NodeFileSystem, NodeHttpServer, NodePath, NodeRuntime } from '@effect/platform-node'
import type { ServeError } from '@effect/platform/HttpServerError'
import { AppsStore } from 'apps-core/livestore'
import { CollectorStore } from 'collector-core/livestore'
import { Duration, Effect, Layer } from 'effect'
import { EmrStore } from 'emr-core/livestore'
import { mintHostOwnerToken, seedFirstPartyClient, seedSigningKey } from 'gatekeeper-core/contexts'
import { GatekeeperStore } from 'gatekeeper-core/livestore'
import { cryptoRandomLayerFromWebCrypto } from 'kitchen-sink/crypto-random'
import { StringLiteralTypes } from 'kitchen-sink/types'
import { LocalHttpServerStore, ServerState } from 'local-http-server-core/livestore'
import { Origin } from 'navigation-core'
import { nodeTelemetryLayerFromEnv } from 'telemetry-node'
import { PublicOrigin } from 'tunnel-core/contexts'
import { TunnelState, TunnelStore } from 'tunnel-core/livestore'
import { webAssetsDir } from 'wildflower-react/web-assets'
import { WebAssetsDir, WildflowerServerLive } from 'wildflower-server'
import { createStore } from './livestore-store.ts'
import { SERVICE_NAME } from './service-name.ts'

// ── Config ──────────────────────────────────────────────────────────

const PORT = Number(process.env['PORT'] ?? 3000)
const ORIGIN = process.env['ORIGIN'] ?? `http://localhost:${PORT}`
if (!StringLiteralTypes.endsWithAlphanumericCharacter(ORIGIN)) {
  throw new Error(`Invalid origin: ${ORIGIN}`)
}
const IS_DEV = process.env['NODE_ENV'] !== 'production'

// ── Platform-dependent Lives ────────────────────────────────────────
// Each of these satisfies one of WildflowerServerLive's peer
// requirements. See the requirements table in Composition Explanation.

const CryptoRandomLive = cryptoRandomLayerFromWebCrypto(globalThis.crypto)

const TelemetryLive = nodeTelemetryLayerFromEnv({
  otel: { serviceName: SERVICE_NAME },
})

const run = Effect.gen(function* () {
  // 1. Open the LiveStore — one shared handle, projected per slice below.
  const store = yield* Effect.promise(() => createStore())

  // Node has no tunnel daemon: seed both the server + tunnel client
  // documents at boot with the static ORIGIN so handlers (e.g.
  // apps-core LaunchApp) see a defined publicOrigin immediately.
  store.commit(
    ServerState.events.localHttpServerStateSet({
      requestedRunning: true,
      running: true,
      port: PORT,
      localOrigin: ORIGIN,
    })
  )
  store.commit(
    TunnelState.events.tunnelStateSet({
      requestedPublicOrigin: ORIGIN,
      currentPublicOrigin: ORIGIN,
    })
  )

  // 2. Build the gatekeeper / slice store layers (all projections of `store`).
  const gatekeeperStoreLayer = GatekeeperStore.layerFrom(store)
  const tunnelStoreLayer = TunnelStore.layerFrom(store)
  const localHttpServerStoreLayer = LocalHttpServerStore.layerFrom(store)
  const originLayer = Layer.succeed(Origin, ORIGIN)
  const publicOriginLayer = Layer.succeed(PublicOrigin, { get: Effect.succeed(ORIGIN) })

  // 3. + 4. Seed signing key + first-party `wildflower-host` client.
  // Idempotent — safe to run on every boot.
  yield* seedSigningKey.pipe(Effect.provide(gatekeeperStoreLayer))
  yield* seedFirstPartyClient.pipe(Effect.provide(gatekeeperStoreLayer))

  // 5. Dev-only bootstrap token. Production uses the device flow; the
  // log line below makes local development a one-paste affair.
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

  // Emitted by `Layer.tap` once the HTTP port is actually bound.
  let afterStartupEffect = Effect.void
  if (bootstrapToken != null) {
    afterStartupEffect = Effect.logInfo(
      `Bootstrap: ${ORIGIN}/gatekeeper?token=${encodeURIComponent(bootstrapToken)}`
    )
  }

  // 6. Compose FullServerLive by providing every peer to
  // WildflowerServerLive. Order within the `.pipe` is bottom-up:
  // earlier `provide`s are higher in the graph and may depend on
  // later ones.
  const FullServerLive: Layer.Layer<never, ServeError, never> = WildflowerServerLive.pipe(
    HttpServer.withLogAddress,
    Layer.tap(() => afterStartupEffect),
    // Slice store projections.
    Layer.provide(EmrStore.layerFrom(store)),
    Layer.provide(AppsStore.layerFrom(store)),
    Layer.provide(CollectorStore.layerFrom(store)),
    Layer.provide(gatekeeperStoreLayer),
    Layer.provide(tunnelStoreLayer),
    Layer.provide(localHttpServerStoreLayer),
    Layer.provide(publicOriginLayer),
    // Cross-cutting platform services.
    Layer.provide(CryptoRandomLive),
    // HTTP transport + static-asset peers.
    Layer.provide(NodeHttpServer.layer(createServer, { port: PORT })),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
    Layer.provide(Layer.succeed(WebAssetsDir, webAssetsDir)),
    Layer.provide(originLayer),
    Layer.provide(TelemetryLive)
  )

  // 7. Launch — binds the HTTP server and runs forever.
  yield* Layer.launch(FullServerLive)
})

NodeRuntime.runMain(run)
