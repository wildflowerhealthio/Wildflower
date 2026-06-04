import { HttpApiBuilder, HttpApiSwagger } from '@effect/platform'
import { Layer } from 'effect'

import { WildflowerHttpApiLive } from './http-api-implementation.ts'
import { middleware } from './middleware/index.ts'
import { StaticSpaLive } from './static-spa.ts'

/**
 * Cross-platform server Layer. Composes the HTTP API (Gatekeeper + FHIR
 * resources/public + Apps + Tunnel + VendorApps), the SPA static-file
 * fallback, and Swagger docs.
 *
 * @remarks
 * Platform runner must supply: `HttpServer.HttpServer`,
 * `FileSystem.FileSystem`, `Path.Path`, `WebAssetsDir`, plus the
 * services the API handlers consume (`Origin`, `CryptoRandom`,
 * `LivestoreStore`, `GatekeeperStore`, `AppsStore`, `TunnelStore`,
 * `LocalHttpServerStore`).
 */
const WildflowerServerLive = HttpApiBuilder.serve(middleware).pipe(
  Layer.provide(
    Layer.merge(Layer.provideMerge(HttpApiSwagger.layer(), WildflowerHttpApiLive), StaticSpaLive)
  )
)

export { WildflowerServerLive }
export { WebAssetsDir } from './static-spa.ts'
