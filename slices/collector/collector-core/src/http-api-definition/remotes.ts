import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { RemoteConfig } from '../livestore/remote.ts'

const RemoteSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  config: RemoteConfig,
  addedAt: Schema.DateTimeUtc,
})

const RemotesSchema = Schema.Array(RemoteSchema)

const CreateRemotePayloadSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  config: RemoteConfig,
})

const UpdateRemotePayloadSchema = Schema.Struct({
  name: Schema.String,
  config: RemoteConfig,
})

const RemoteNotFoundSchema = Schema.Struct({
  error: Schema.Literal('RemoteNotFound'),
  id: Schema.String,
})

const httpApiGroup = HttpApiGroup.make('collector-remotes', { topLevel: false })
  .add(HttpApiEndpoint.get('ListRemotes', '/remotes').addSuccess(RemotesSchema))
  .add(
    HttpApiEndpoint.get('GetRemote', '/remotes/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(RemoteSchema)
      .addError(RemoteNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post('CreateRemote', '/remotes')
      .setPayload(CreateRemotePayloadSchema)
      .addSuccess(RemoteSchema)
  )
  .add(
    HttpApiEndpoint.put('UpdateRemote', '/remotes/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .setPayload(UpdateRemotePayloadSchema)
      .addSuccess(RemoteSchema)
      .addError(RemoteNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.del('DeleteRemote', '/remotes/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(Schema.Struct({ deleted: Schema.Boolean }))
      .addError(RemoteNotFoundSchema, { status: 404 })
  )
  .prefix('/collector')

export {
  httpApiGroup,
  RemoteSchema,
  RemotesSchema,
  CreateRemotePayloadSchema,
  UpdateRemotePayloadSchema,
  RemoteNotFoundSchema,
}
