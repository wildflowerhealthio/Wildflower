import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import {
  AppEntrySchema,
  AppIdPathSchema,
  AppNotEditableSchema,
  AppNotFoundSchema,
  AppSchema,
  CreateAppBodySchema,
  InvalidFieldSchema,
  PlacementBodySchema,
  UpdateAppBodySchema,
} from './schemas.ts'

/**
 * Owner-only mutations on the apps catalogue. The group itself carries
 * no middleware — `wildflower-server` (or any other composing app)
 * applies `RequireAuthMiddleware` when adding `AppsAdminApi` to its
 * root `HttpApi`. Slice cores stay free of auth dependencies.
 *
 * Create / update / delete operate on **cloud** apps only: a system or
 * self-hosted app that exists returns `409 AppNotEditable`, an unknown id
 * `404`. A bad name/url is a `400 InvalidField`. `PATCH /apps/:id/placement`
 * is the exception — it reorders / enables **any** provenance (homescreen
 * curation), so it carries no editability gate.
 */
const httpApiGroup = HttpApiGroup.make('apps-admin', { topLevel: false })
  .add(
    HttpApiEndpoint.post('CreateApp', '/apps')
      .setPayload(CreateAppBodySchema)
      .addSuccess(AppEntrySchema)
      .addError(InvalidFieldSchema, { status: 400 })
  )
  .add(
    HttpApiEndpoint.patch('UpdateApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .setPayload(UpdateAppBodySchema)
      .addSuccess(AppEntrySchema)
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
    // Reorder / enable any app (all provenances) — the registry-row placement,
    // distinct from the cloud-only content edit above.
    HttpApiEndpoint.patch('UpdatePlacement', '/apps/:id/placement')
      .setPath(AppIdPathSchema)
      .setPayload(PlacementBodySchema)
      .addSuccess(AppSchema)
      .addError(AppNotFoundSchema, { status: 404 })
  )

export { httpApiGroup }
