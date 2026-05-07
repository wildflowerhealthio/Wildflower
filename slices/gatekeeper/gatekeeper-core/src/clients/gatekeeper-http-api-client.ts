import { HttpApiClient } from '@effect/platform'
import { Context, type Effect } from 'effect'

import { GatekeeperApi } from '../http-api-definition/index.ts'

// Bare HttpApiClient effect used to extract the resolved client shape
// without committing to a specific transformClient/baseUrl. The
// reference is type-only at the call site and is tree-shaken away.
const _bareGatekeeperClient = HttpApiClient.make(GatekeeperApi, { baseUrl: '/' })
type GatekeeperHttpApiClientShape = Effect.Effect.Success<typeof _bareGatekeeperClient>

/**
 * Effect Service providing the resolved `GatekeeperApi` HttpApi
 * client. Adapter layers (`gatekeeper-web`, `gatekeeper-expo`) build
 * the client and provide it via `Layer.effect(GatekeeperHttpApiClient, …)`;
 * call sites consume it Effect-natively:
 *
 * ```ts
 * Effect.flatMap(GatekeeperHttpApiClient, (c) =>
 *   c['access-management'].ListGrants()
 * )
 * ```
 *
 * Defining the tag in `-core` keeps the contract platform-agnostic —
 * the same Effect compiles against any adapter that fills the tag.
 */
class GatekeeperHttpApiClient extends Context.Tag('GatekeeperHttpApiClient')<
  GatekeeperHttpApiClient,
  GatekeeperHttpApiClientShape
>() {}

export { GatekeeperHttpApiClient, type GatekeeperHttpApiClientShape }
