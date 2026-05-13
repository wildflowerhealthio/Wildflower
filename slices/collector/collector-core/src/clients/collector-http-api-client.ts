import { HttpApiClient } from '@effect/platform'
import { Context, type Effect } from 'effect'

import { CollectorApi } from '../http-api-definition/index.ts'

// Type-only reference to extract the resolved client shape; tree-shaken
// at call sites. Mirrors gatekeeper-core's GatekeeperHttpApiClient.
const _bareCollectorClient = HttpApiClient.make(CollectorApi, { baseUrl: '/' })
type CollectorHttpApiClientShape = Effect.Effect.Success<typeof _bareCollectorClient>

/**
 * Effect Service providing the resolved `CollectorApi` HttpApi client.
 * `collector-react` provides it via `<CollectorClientProvider>`
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
