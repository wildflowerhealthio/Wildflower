import { HttpApi } from '@effect/platform'
import * as Tunnel from './tunnel.ts'

/**
 * Owner-only surface — the read-only tunnel state. The host
 * gates this surface: in the Tauri app the Rust server serves `/tunnel`
 * behind the gatekeeper Owner check. Slice cores stay free of auth deps.
 */
const TunnelAdminApi = HttpApi.make('TunnelAdminApi').add(Tunnel.httpApiGroup)

export { TunnelAdminApi, Tunnel }
