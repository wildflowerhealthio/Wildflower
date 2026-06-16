import { HttpApiClient } from '@effect/platform'
import { Context, type Effect } from 'effect'

import { TunnelAdminApi } from '../http-api-definition/index.ts'

// Type-only references to extract the resolved client shape; tree-shaken
// at call sites. Mirrors `apps-core/clients` and `gatekeeper-core/clients`.

// oxlint-disable no-underscore-dangle
const _bareAdminClient = HttpApiClient.make(TunnelAdminApi)
type TunnelAdminHttpApiClientShape = Effect.Effect.Success<typeof _bareAdminClient>
// oxlint-enable no-underscore-dangle

/**
 * Effect Service providing the resolved `TunnelAdminApi` (owner-only)
 * HttpApi client — `GetTunnel` + `ReplaceTunnel`. The host gates the
 * `/tunnel` surface (the Tauri app's Rust server checks the gatekeeper
 * Owner token), so the corresponding client layer must attach a bearer.
 */
class TunnelAdminHttpApiClient extends Context.Tag('TunnelAdminHttpApiClient')<
  TunnelAdminHttpApiClient,
  TunnelAdminHttpApiClientShape
>() {}

export { TunnelAdminHttpApiClient, type TunnelAdminHttpApiClientShape }
