import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import {
  AppEntrySchema,
  AppIdPathSchema,
  AppNotFoundSchema,
  BundledAppImmutableSchema,
  CreateCustomAppBodySchema,
  UpdateAppBodySchema,
} from './schemas.ts'

/**
 * Owner-only mutations on the apps catalogue. The group itself carries
 * no middleware — `wildflower-server` (or any other composing app)
 * applies `RequireAuthMiddleware` when adding `AppsAdminApi` to its
 * root `HttpApi`. Slice cores stay free of auth dependencies.
 */
const httpApiGroup = HttpApiGroup.make('apps-admin', { topLevel: false })
  .add(
    HttpApiEndpoint.post('CreateCustomApp', '/apps')
      .setPayload(CreateCustomAppBodySchema)
      .addSuccess(AppEntrySchema)
  )
  .add(
    HttpApiEndpoint.patch('UpdateApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .setPayload(UpdateAppBodySchema)
      .addSuccess(AppEntrySchema)
      .addError(AppNotFoundSchema, { status: 404 })
      .addError(BundledAppImmutableSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.del('DeleteApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(Schema.Struct({ deleted: Schema.Boolean }))
      .addError(AppNotFoundSchema, { status: 404 })
      .addError(BundledAppImmutableSchema, { status: 403 })
  )

export { httpApiGroup }
