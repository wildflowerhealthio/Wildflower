import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import {
  AppBodySchema,
  AppIdPathSchema,
  AppListSchema,
  AppNotFoundSchema,
  AppRegistrationSchema,
  HomeScreenSchema,
  InsufficientScopeSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
} from './schemas.ts'

/**
 * Owner-only mutations + by-id reads on the apps catalogue. The group itself
 * carries no middleware — `wildflower-server` (or any other composing app)
 * applies `RequireAuthMiddleware` when adding `AppsAdminApi` to its root
 * `HttpApi`, so slice cores stay free of auth dependencies. Each endpoint is
 * additionally scope-gated on the Rust side (`wildflower/Apps.{r,c,u,d}`), which
 * surfaces as a `403 InsufficientScope` when the caller's token doesn't cover it.
 *
 * `POST /apps` creates an app and `GET`/`PUT`/`DELETE /apps/:id` read, replace,
 * and remove one, each returning the {@link AppRegistrationSchema} (delete
 * answers `204`); `PUT /home-screen` atomically reorders / enables every app.
 * See `docs/Apps/Explanation.md` and the per-endpoint schemas.
 */
const httpApiGroup = HttpApiGroup.make('apps-admin', { topLevel: false })
  .add(
    // Create an app from a JSON body ({@link AppBodySchema}).
    HttpApiEndpoint.post('CreateApp', '/apps')
      .setPayload(AppBodySchema)
      .addSuccess(AppRegistrationSchema)
      .addError(InvalidFieldSchema, { status: 400 })
      .addError(InsufficientScopeSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.get('GetApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(AppRegistrationSchema)
      .addError(InsufficientScopeSchema, { status: 403 })
      .addError(AppNotFoundSchema, { status: 404 })
  )
  .add(
    // Full-replace an app's content.
    HttpApiEndpoint.put('ReplaceApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .setPayload(AppBodySchema)
      .addSuccess(AppRegistrationSchema)
      .addError(InvalidFieldSchema, { status: 400 })
      .addError(InsufficientScopeSchema, { status: 403 })
      .addError(AppNotFoundSchema, { status: 404 })
  )
  .add(
    // Delete an app. `204` on success.
    HttpApiEndpoint.del('DeleteApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(HttpApiSchema.NoContent)
      .addError(InsufficientScopeSchema, { status: 403 })
      .addError(AppNotFoundSchema, { status: 404 })
  )
  .add(
    // The full ordered homescreen, distinct from the content edits above — see
    // {@link HomeScreenSchema}.
    HttpApiEndpoint.put('ReplaceHomeScreen', '/home-screen')
      .setPayload(HomeScreenSchema)
      .addSuccess(AppListSchema)
      .addError(InvalidHomeScreenSchema, { status: 400 })
      .addError(InsufficientScopeSchema, { status: 403 })
  )

export { httpApiGroup }
