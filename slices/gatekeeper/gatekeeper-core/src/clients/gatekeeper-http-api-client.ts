import { HttpApiClient } from '@effect/platform'
import { Context, type Effect } from 'effect'

import { GatekeeperApi } from '../http-api-definition/index.ts'

// Type-only reference to extract the resolved client shape; tree-shaken at call sites.
// oxlint-disable-next-line no-underscore-dangle
const _bareGatekeeperClient = HttpApiClient.make(GatekeeperApi, { baseUrl: '/' })
type GatekeeperHttpApiClientShape = Effect.Effect.Success<typeof _bareGatekeeperClient>

/**
 * Effect Service providing the resolved `GatekeeperApi` HttpApi client.
 * Adapter layers (`gatekeeper-react`, `gatekeeper-expo`) provide it; call
 * sites consume Effect-natively.
 *
 * @example
 * ```ts
 * Effect.flatMap(GatekeeperHttpApiClient, (c) =>
 *   c['access-management'].ListGrants()
 * )
 * ```
 */
class GatekeeperHttpApiClient extends Context.Tag('GatekeeperHttpApiClient')<
  GatekeeperHttpApiClient,
  GatekeeperHttpApiClientShape
>() {}

export { GatekeeperHttpApiClient, type GatekeeperHttpApiClientShape }
