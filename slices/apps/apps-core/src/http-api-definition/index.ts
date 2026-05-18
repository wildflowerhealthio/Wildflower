import { HttpApi } from '@effect/platform'
import * as AppsAdmin from './apps-admin.ts'
import * as Apps from './apps.ts'
import * as Schemas from './schemas.ts'

/**
 * Public surface — `ListApps` + `LaunchApp`. No auth; reachable by
 * embedded webviews and iframes that can't easily carry a bearer.
 */
const AppsApi = HttpApi.make('AppsApi').add(Apps.httpApiGroup)

/**
 * Owner-only surface — custom-app writes. The composing app (e.g.
 * `wildflower-server`) applies `RequireAuthMiddleware` to this `HttpApi`;
 * slice cores stay free of auth deps. Tunnel state moved to the
 * `tunnel-core` slice and is composed at the host level.
 */
const AppsAdminApi = HttpApi.make('AppsAdminApi').add(AppsAdmin.httpApiGroup)

export { AppsAdmin, AppsAdminApi, Apps, AppsApi, Schemas }
