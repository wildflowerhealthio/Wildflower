import './instrument.ts'
import { createServer } from 'node:http'
import { HttpServer } from '@effect/platform'
import { NodeFileSystem, NodeHttpServer, NodePath, NodeRuntime } from '@effect/platform-node'
import { makeAppsStoreLayer } from 'apps-core/contexts'
import type { ServerState } from 'apps-core/contexts'
import { makeCollectorStoreLayer } from 'collector-core/contexts'
import { Duration, Effect, Layer } from 'effect'
import { makeLivestoreStoreLayer } from 'emr-core/contexts'
import {
  makeGatekeeperStoreLayer,
  mintHostOwnerToken,
  seedFirstPartyClient,
  seedSigningKey,
} from 'gatekeeper-core/contexts'
import { cryptoRandomLayerFromWebCrypto } from 'kitchen-sink/crypto-random'
import { StringLiteralTypes } from 'kitchen-sink/types'
import { Origin } from 'navigation-core'
import { nodeTelemetryLayerFromEnv } from 'telemetry-node'
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
  const gatekeeperStoreLayer = makeGatekeeperStoreLayer(store)
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

  // `apps-core`'s `TunnelControl` returns a static `ServerState`; on the
  // node host there is no tunnel, so `tunnelActive` is `false` at start
  // and `setTunnelActive` fails. Mobile hosts swap in their own Live.
  const serverState: ServerState = {
    origin: ORIGIN,
    localOrigin: ORIGIN,
    port: PORT,
    tunnelActive: false,
  }

  const FullServerLive = WildflowerServerLive.pipe(
    HttpServer.withLogAddress,
    Layer.tap(() => afterStartupEffect),
    Layer.provide(makeLivestoreStoreLayer(store)),
    Layer.provide(makeAppsStoreLayer(store)),
    Layer.provide(TunnelControlLive(serverState)),
    Layer.provide(gatekeeperStoreLayer),
    Layer.provide(makeCollectorStoreLayer(store)),
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
