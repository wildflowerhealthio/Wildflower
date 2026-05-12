import { HttpApiClient } from '@effect/platform'
import { Context, type Effect } from 'effect'

import { CollectorApi } from '../http-api-definition/index.ts'

// Pure type-level extractor — `declare const` emits no JS, so there's
// no `HttpApiClient.make` call at module init and no dummy `baseUrl`
// literal embedded in consumer bundles. The shape is derived purely
// from `typeof HttpApiClient.make` parameterised on the
// `CollectorApi` shape, using TS 4.7+ instantiation expressions.
declare const bareCollectorClient: ReturnType<typeof HttpApiClient.make<typeof CollectorApi>>
type CollectorHttpApiClientShape = Effect.Effect.Success<typeof bareCollectorClient>

/**
 * Effect Service providing the resolved `CollectorApi` HttpApi client.
 * `collector-react` provides it via `<CollectorClientProvider token>`
 * (mirrors `GatekeeperHttpApiClient` from `gatekeeper-core/clients`);
 * call sites consume it Effect-natively.
 *
 * @example
 * ```ts
 * Effect.flatMap(CollectorHttpApiClient, (c) =>
 *   c['collector-remotes'].ListRemotes()
 * )
 * ```
 */
class CollectorHttpApiClient extends Context.Tag('CollectorHttpApiClient')<
  CollectorHttpApiClient,
  CollectorHttpApiClientShape
>() {}

export { CollectorHttpApiClient, type CollectorHttpApiClientShape }
