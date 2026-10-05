import { HttpApi } from '@effect/platform'
import * as Tunnels from './tunnels.ts'

/**
 * The relay's admin API, served on `admin.<domain>` to requests signed with
 * the admin key. The signing is the client's `HttpClient`'s job (see
 * `relay-core/signing`), so the definition carries no middleware.
 */
const RelayAdminApi = HttpApi.make('RelayAdminApi').add(Tunnels.httpApiGroup)

export { RelayAdminApi, Tunnels }
