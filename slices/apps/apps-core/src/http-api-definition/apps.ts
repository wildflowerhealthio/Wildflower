import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'
import { AppIdSchema, AppKindSchema } from '../registry/app-item.ts'

const AppEntrySchema = Schema.Struct({
  id: AppIdSchema,
  name: Schema.String,
  subtitle: Schema.String,
  requiresTunnel: Schema.Boolean,
  kind: AppKindSchema,
  enabled: Schema.Boolean,
})

const AppListSchema = Schema.Array(AppEntrySchema)

const CreateCustomAppBodySchema = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  requiresTunnel: Schema.Boolean,
})

const UpdateAppBodySchema = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  requiresTunnel: Schema.optional(Schema.Boolean),
})

const AppNotFoundSchema = Schema.Struct({
  error: Schema.Literal('AppNotFound'),
  id: Schema.String,
})

const BundledAppImmutableSchema = Schema.Struct({
  error: Schema.Literal('BundledAppImmutable'),
  id: Schema.String,
})

const httpApiGroup = HttpApiGroup.make('apps', { topLevel: false })
  .add(HttpApiEndpoint.get('ListApps', '/apps').addSuccess(AppListSchema))
  .add(
    HttpApiEndpoint.post('CreateCustomApp', '/apps')
      .setPayload(CreateCustomAppBodySchema)
      .addSuccess(AppEntrySchema)
  )
  .add(
    HttpApiEndpoint.patch('UpdateApp', '/apps/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .setPayload(UpdateAppBodySchema)
      .addSuccess(AppEntrySchema)
      .addError(AppNotFoundSchema, { status: 404 })
      .addError(BundledAppImmutableSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.del('DeleteApp', '/apps/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(Schema.Struct({ deleted: Schema.Boolean }))
      .addError(AppNotFoundSchema, { status: 404 })
      .addError(BundledAppImmutableSchema, { status: 403 })
  )
  .add(
    HttpApiEndpoint.get('LaunchApp', '/apps/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' }))
  )

export {
  httpApiGroup,
  AppEntrySchema,
  AppListSchema,
  CreateCustomAppBodySchema,
  UpdateAppBodySchema,
  AppNotFoundSchema,
  BundledAppImmutableSchema,
}
