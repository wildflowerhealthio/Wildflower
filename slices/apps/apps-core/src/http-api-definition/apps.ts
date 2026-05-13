import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { AppIdPathSchema, AppListSchema, AppNotFoundSchema } from './schemas.ts'

/**
 * Public read/launch endpoints for the apps catalogue. Reachable by
 * embedded webviews and iframes that can't easily carry a bearer
 * token. Owner-mutating routes (create / update / delete / tunnel
 * config) live on `AppsAdminApi` and the consumer wraps that one in
 * `RequireAuthMiddleware`.
 */
const httpApiGroup = HttpApiGroup.make('apps', { topLevel: false })
  .add(HttpApiEndpoint.get('ListApps', '/apps').addSuccess(AppListSchema))
  .add(
    HttpApiEndpoint.get('LaunchApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' }))
      .addError(AppNotFoundSchema, { status: 404 })
  )

export { httpApiGroup }
