import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import {
  AppEntrySchema,
  AppIdPathSchema,
  AppListSchema,
  AppNotEditableSchema,
  AppNotFoundSchema,
  CreateAppBodySchema,
  HomeScreenSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
  UpdateAppBodySchema,
} from './schemas.ts'

/**
 * Owner-only mutations on the apps catalogue. The group itself carries
 * no middleware — `wildflower-server` (or any other composing app)
 * applies `RequireAuthMiddleware` when adding `AppsAdminApi` to its
 * root `HttpApi`. Slice cores stay free of auth dependencies.
 *
 * Create / update / delete operate on **cloud** apps' content only: a system or
 * self-hosted app that exists returns `409 AppNotEditable`, an unknown id
 * `404`. A bad name/url is a `400 InvalidField`. `PUT /home-screen` is the
 * exception — it atomically reorders / enables **every** provenance (homescreen
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
    // The full ordered homescreen (all provenances), distinct from the cloud-only
    // content edit above — see {@link HomeScreenSchema}.
    HttpApiEndpoint.put('ReplaceHomeScreen', '/home-screen')
      .setPayload(HomeScreenSchema)
      .addSuccess(AppListSchema)
      .addError(InvalidHomeScreenSchema, { status: 400 })
  )

export { httpApiGroup }
