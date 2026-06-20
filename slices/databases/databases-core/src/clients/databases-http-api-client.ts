import { HttpApiClient } from '@effect/platform'
import { Context, type Effect } from 'effect'

import { DatabasesApi } from '../http-api-definition/index.ts'

// Type-only references to extract the resolved client shape; tree-shaken at call
// sites. Mirrors `apps-core/clients` and `tunnel-core/clients`.

// oxlint-disable no-underscore-dangle
const _bareClient = HttpApiClient.make(DatabasesApi)
type DatabasesHttpApiClientShape = Effect.Effect.Success<typeof _bareClient>
// oxlint-enable no-underscore-dangle

/**
 * Effect Service providing the resolved `DatabasesApi` (owner-only) HttpApi
 * client — `ListDatabases` + `DeleteDatabase`. The host gates the `/databases`
 * surface (the Tauri app's Rust server checks the gatekeeper Owner token), so
 * the corresponding client layer must attach a bearer.
 */
class DatabasesHttpApiClient extends Context.Tag('DatabasesHttpApiClient')<
  DatabasesHttpApiClient,
  DatabasesHttpApiClientShape
>() {}

export { DatabasesHttpApiClient, type DatabasesHttpApiClientShape }
