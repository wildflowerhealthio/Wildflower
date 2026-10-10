import { HttpApi } from '@effect/platform'
import * as Databases from './databases.ts'

/**
 * Data-management surface over the host's SQLite databases (list + delete). The
 * host gates this surface: in the Tauri app the Rust server serves `/databases`
 * behind the gatekeeper bearer gate for authN, then authorizes download/delete
 * per database by its declared scope (a `403 InsufficientScope` otherwise).
 * Slice cores stay free of auth deps.
 */
const DatabasesApi = HttpApi.make('DatabasesApi').add(Databases.httpApiGroup)

export { DatabasesApi, Databases }
