import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import {
  AppContentBodySchema,
  AppIdPathSchema,
  AppListEntrySchema,
  AppListSchema,
  AppNotEditableSchema,
  AppNotFoundSchema,
  CreateAppBodySchema,
  HomeScreenSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
} from './schemas.ts'

/**
 * Owner-only mutations on the apps catalogue. The group itself carries no
 * middleware — `wildflower-server` (or any other composing app) applies
 * `RequireAuthMiddleware` when adding `AppsAdminApi` to its root `HttpApi`, so
 * slice cores stay free of auth dependencies.
 *
 * `POST /apps` creates (cloud or self-hosted, keyed on the multipart body's
 * `provenance`), `PUT /apps/:id` replaces an editable app's content, and
 * `DELETE /apps/:id` removes it — each returning the discriminated
 * {@link AppListEntrySchema}; `PUT /home-screen` atomically reorders / enables
 * every provenance. See `docs/Apps/Explanation.md` and the per-endpoint schemas.
 */
const httpApiGroup = HttpApiGroup.make('apps-admin', { topLevel: false })
  .add(
    // Create a cloud or self-hosted app. The body is `multipart/form-data`
    // ({@link CreateAppBodySchema}) discriminated on `provenance`: cloud carries
    // name/url/requiresTunnel, self-hosted carries name + the uploaded `bundle`.
    // A multipart endpoint's typed client payload is a `FormData` instance.
    HttpApiEndpoint.post('CreateApp', '/apps')
      .setPayload(CreateAppBodySchema)
      .addSuccess(AppListEntrySchema)
      .addError(InvalidFieldSchema, { status: 400 })
  )
  .add(
    // Replace an editable app's content. The body is a provenance-discriminated
    // union ({@link AppContentBodySchema}) whose arm must match the stored app's
    // kind; the response is the refreshed catalogue entry. A system app, a
    // seeded self-hosted app, or a provenance mismatch is `409 AppNotEditable`.
    HttpApiEndpoint.put('ReplaceApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .setPayload(AppContentBodySchema)
      .addSuccess(AppListEntrySchema)
      .addError(InvalidFieldSchema, { status: 400 })
      .addError(AppNotFoundSchema, { status: 404 })
      .addError(AppNotEditableSchema, { status: 409 })
  )
  .add(
    HttpApiEndpoint.del('DeleteApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(Schema.Struct({ deleted: Schema.Boolean }))
      .addError(AppNotFoundSchema, { status: 404 })
      .addError(AppNotEditableSchema, { status: 409 })
  )
  .add(
    // The full ordered homescreen (all provenances), distinct from the cloud-only
    // content edit above — see {@link HomeScreenSchema}.
    HttpApiEndpoint.put('ReplaceHomeScreen', '/home-screen')
      .setPayload(HomeScreenSchema)
      .addSuccess(AppListSchema)
      .addError(InvalidHomeScreenSchema, { status: 400 })
  )

export { httpApiGroup }
