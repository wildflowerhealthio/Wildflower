import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import {
  AppEntrySchema,
  AppIdPathSchema,
  AppNotFoundSchema,
  CreateAppBodySchema,
  InvalidFieldSchema,
  UpdateAppBodySchema,
} from './schemas.ts'

/**
 * Owner-only mutations on the apps catalogue. The group itself carries
 * no middleware — `wildflower-server` (or any other composing app)
 * applies `RequireAuthMiddleware` when adding `AppsAdminApi` to its
 * root `HttpApi`. Slice cores stay free of auth dependencies.
 *
 * Every app is editable and deletable — no app is immutable. A bad name/url
 * is a `400 InvalidField`.
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
  )
  .add(
    HttpApiEndpoint.del('DeleteApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(Schema.Struct({ deleted: Schema.Boolean }))
      .addError(AppNotFoundSchema, { status: 404 })
  )

export { httpApiGroup }
