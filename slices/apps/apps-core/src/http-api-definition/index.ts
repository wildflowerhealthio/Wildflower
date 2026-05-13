import { HttpApi } from '@effect/platform'
import * as AppsAdmin from './apps-admin.ts'
import * as Apps from './apps.ts'
import * as Schemas from './schemas.ts'
import * as Server from './server.ts'

/**
 * Public surface — `ListApps` + `LaunchApp`. No auth; reachable by
 * embedded webviews and iframes that can't easily carry a bearer.
 */
const AppsApi = HttpApi.make('AppsApi').add(Apps.httpApiGroup)

/**
 * Owner-only surface — custom-app writes + tunnel state. The composing
 * app (e.g. `wildflower-server`) applies `RequireAuthMiddleware` to
 * this `HttpApi`; slice cores stay free of auth deps.
 */
const AppsAdminApi = HttpApi.make('AppsAdminApi')
  .add(AppsAdmin.httpApiGroup)
  .add(Server.httpApiGroup)

export { AppsApi, AppsAdminApi, Apps, AppsAdmin, Schemas, Server }
