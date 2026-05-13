import { HttpApiClient } from '@effect/platform'
import { Context, type Effect } from 'effect'

import { AppsApi } from '../http-api-definition/index.ts'

// Type-only reference to extract the resolved client shape; tree-shaken
// at call sites. Mirrors collector-core's CollectorHttpApiClient and
// gatekeeper-core's GatekeeperHttpApiClient.
const _bareAppsClient = HttpApiClient.make(AppsApi, { baseUrl: '/' })
type AppsHttpApiClientShape = Effect.Effect.Success<typeof _bareAppsClient>

/**
 * Effect Service providing the resolved `AppsApi` HttpApi client.
 * `apps-react` provides it via `<AppsClientProvider>` (mirrors
 * `CollectorHttpApiClient` from `collector-core/clients`); call sites
 * consume it Effect-natively.
 *
 * @example
 * ```ts
 * Effect.flatMap(AppsHttpApiClient, (c) => c.apps.ListApps())
 * ```
 */
class AppsHttpApiClient extends Context.Tag('AppsHttpApiClient')<
  AppsHttpApiClient,
  AppsHttpApiClientShape
>() {}

export { AppsHttpApiClient, type AppsHttpApiClientShape }
