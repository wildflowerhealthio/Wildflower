import { HttpApi } from '@effect/platform'
import * as AppsAdmin from './apps-admin.ts'
import * as Apps from './apps.ts'
import * as Schemas from './schemas.ts'

/**
 * Read + launch surface — `ListApps` + `LaunchApp`. Carries no TS-side
 * middleware; the canonical host owner-gates `ListApps` and mounts `LaunchApp`
 * ungated. See {@link Apps} and `docs/Apps/Explanation.md` §"Auth posture".
 */
const AppsApi = HttpApi.make('AppsApi').add(Apps.httpApiGroup)

/**
 * Owner-only surface — app writes (create / update / delete). The composing
 * app (e.g. `wildflower-server`) applies `RequireAuthMiddleware` to this
 * `HttpApi`; slice cores stay free of auth deps. Tunnel state lives
 * on `TunnelAdminApi` from `tunnel-core/http-api-definition`.
 */
const AppsAdminApi = HttpApi.make('AppsAdminApi').add(AppsAdmin.httpApiGroup)

export { AppsApi, AppsAdminApi, Apps, AppsAdmin, Schemas }
