import { HttpApi } from '@effect/platform'
import * as Tunnel from './tunnel.ts'

/**
 * Owner-only surface — tunnel state read + toggle. The composing app
 * (e.g. `wildflower-server`) applies `RequireAuthMiddleware` to this
 * `HttpApi`; slice cores stay free of auth deps.
 */
const TunnelAdminApi = HttpApi.make('TunnelAdminApi').add(Tunnel.httpApiGroup)

export { TunnelAdminApi, Tunnel }
