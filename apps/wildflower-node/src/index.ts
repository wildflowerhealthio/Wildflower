import './instrument.ts'
import { createServer } from 'node:http'
import { NodeFileSystem, NodeHttpServer, NodePath, NodeRuntime } from '@effect/platform-node'
import { Duration, Effect, Layer } from 'effect'
import { makeLivestoreStoreLayer } from 'emr-core/contexts'
import {
  makeGatekeeperStoreLayer,
  mintHostOwnerToken,
  seedFirstPartyClient,
} from 'gatekeeper-core/contexts'
import { Origin } from 'kitchen-sink'
import { CryptoRandomLayerLive } from 'kitchen-sink/crypto-random'
import { StringLiteralTypes } from 'kitchen-sink/types'
import { webAssetsDir } from 'wildflower-react/web-assets'
import { WebAssetsDir, WildflowerServerLive } from 'wildflower-server'
import { createStore } from './LivestoreStore.ts'
import { TelemetryLive } from './telemetry.ts'

const PORT = Number(process.env['PORT'] ?? 3000)
const ORIGIN = process.env['ORIGIN'] ?? `http://localhost:${PORT}`
if (!StringLiteralTypes.endsWithAlphanumericCharacter(ORIGIN)) {
  throw new Error(`Invalid origin: ${ORIGIN}`)
}
const IS_DEV = process.env['NODE_ENV'] !== 'production'
const BOOTSTRAP_TOKEN_TTL = Duration.hours(1)

const CryptoRandomLive = CryptoRandomLayerLive<
  Uint8Array & ReturnType<typeof globalThis.crypto.getRandomValues>
>(globalThis.crypto, new Uint8Array(1))

const run = Effect.gen(function* () {
  const store = yield* Effect.promise(() => createStore())
  const gatekeeperStoreLayer = makeGatekeeperStoreLayer(store)
  const originLayer = Layer.succeed(Origin, ORIGIN)

  // Always seed the first-party `wildflower-host` client — that's this
  // server's own identity, idempotent across restarts. The Owner-token mint
  // and the bootstrap-URL log line are dev-only convenience: in production
  // the operator authenticates via the device flow, not a token printed to
  // stdout. Gated on NODE_ENV so the token never lands in prod logs.
  yield* seedFirstPartyClient.pipe(
    Effect.provide(gatekeeperStoreLayer),
    Effect.provide(originLayer)
  )

  if (IS_DEV) {
    yield* mintHostOwnerToken({ ttl: BOOTSTRAP_TOKEN_TTL }).pipe(
      Effect.provide(gatekeeperStoreLayer),
      Effect.provide(originLayer),
      Effect.tap((token) =>
        Effect.logInfo(
          `Server is running. Bootstrap: ${ORIGIN}/gatekeeper?token=${encodeURIComponent(token)}`
        )
      ),
      Effect.catchAll((err) =>
        Effect.logError(`Server is running on ${ORIGIN}. Bootstrap token unavailable.`, err)
      )
    )
  } else {
    yield* Effect.logInfo(`Server is running on ${ORIGIN}.`)
  }

  const FullServerLive = WildflowerServerLive.pipe(
    Layer.provide(makeLivestoreStoreLayer(store)),
    Layer.provide(gatekeeperStoreLayer),
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
