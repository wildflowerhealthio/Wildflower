import { HttpApiClient } from '@effect/platform'
import { Context, type Effect } from 'effect'

import { AppsAdminApi, AppsApi } from '../http-api-definition/index.ts'

// Type-only references to extract the resolved client shape; tree-shaken
// at call sites. Mirrors `collector-core/clients` and
// `gatekeeper-core/clients`.

const _barePublicClient = HttpApiClient.make(AppsApi, { baseUrl: '/' })
type AppsHttpApiClientShape = Effect.Effect.Success<typeof _barePublicClient>

const _bareAdminClient = HttpApiClient.make(AppsAdminApi, { baseUrl: '/' })
type AppsAdminHttpApiClientShape = Effect.Effect.Success<typeof _bareAdminClient>

/**
 * Effect Service providing the resolved `AppsApi` (public) HttpApi
 * client — `ListApps` + `LaunchApp`. No bearer token required;
 * consumers should *not* attach `Authorization` headers.
 */
class AppsHttpApiClient extends Context.Tag('AppsHttpApiClient')<
  AppsHttpApiClient,
  AppsHttpApiClientShape
>() {}

/**
 * Effect Service providing the resolved `AppsAdminApi` (owner-only)
 * HttpApi client — custom-app writes + server (tunnel) config. The
 * composing app wraps `AppsAdminApi` in `RequireAuthMiddleware`, so
 * the corresponding client layer must attach a bearer.
 */
class AppsAdminHttpApiClient extends Context.Tag('AppsAdminHttpApiClient')<
  AppsAdminHttpApiClient,
  AppsAdminHttpApiClientShape
>() {}

export {
  AppsHttpApiClient,
  AppsAdminHttpApiClient,
  type AppsHttpApiClientShape,
  type AppsAdminHttpApiClientShape,
}
