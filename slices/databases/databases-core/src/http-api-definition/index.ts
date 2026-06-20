import { HttpApi } from '@effect/platform'
import * as Databases from './databases.ts'

/**
 * Owner-only surface — data management over the host's SQLite databases (list +
 * delete). The host gates this surface: in the Tauri app the Rust server serves
 * `/databases` behind the gatekeeper Owner check. Slice cores stay free of auth
 * deps.
 */
const DatabasesApi = HttpApi.make('DatabasesApi').add(Databases.httpApiGroup)

export { DatabasesApi, Databases }
