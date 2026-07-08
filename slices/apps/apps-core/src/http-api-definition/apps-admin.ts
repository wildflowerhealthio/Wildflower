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
  CreateSelfHostedAppUrlParamsSchema,
  HomeScreenSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
  ZipPayloadSchema,
} from './schemas.ts'

/**
 * Owner-only mutations on the apps catalogue. The group itself carries
 * no middleware — `wildflower-server` (or any other composing app)
 * applies `RequireAuthMiddleware` when adding `AppsAdminApi` to its
 * root `HttpApi`. Slice cores stay free of auth dependencies.
 *
 * Create / replace / delete: `POST /apps` creates a cloud app; `PUT /apps/:id`
 * replaces an editable app's content (cloud or self-hosted, keyed on the body's
 * provenance); `DELETE /apps/:id` removes it. A system app, a seeded self-hosted
 * app, or a provenance mismatch is `409 AppNotEditable`, an unknown id `404`, a
 * bad name/url `400 InvalidField`. Every one of these responses is the
 * `provenance`-discriminated {@link AppListEntrySchema}. `PUT /home-screen` is
 * the exception — it atomically reorders / enables **every** provenance.
 */
const httpApiGroup = HttpApiGroup.make('apps-admin', { topLevel: false })
  .add(
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
    // Install an uploaded zip bundle as a new self-hosted app. Deliberately
    // `/self-hosted-apps` (not `/apps/self-hosted`) so it can't shadow the
    // ungated `POST /apps/{id}` launch route. The `name` query param is slugged
    // server-side into the id/subdomain; the raw `application/zip` body carries
    // the app's static files. A bad name or unusable bundle is a `400
    // InvalidField` (`InvalidName` / `InvalidZip`).
    HttpApiEndpoint.post('CreateSelfHostedApp', '/self-hosted-apps')
      .setUrlParams(CreateSelfHostedAppUrlParamsSchema)
      .setPayload(ZipPayloadSchema)
      .addSuccess(AppListEntrySchema)
      .addError(InvalidFieldSchema, { status: 400 })
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
