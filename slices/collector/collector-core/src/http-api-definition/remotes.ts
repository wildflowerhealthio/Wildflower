import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { CollectorConfig, CollectorTag } from '../registry.ts'

const RemoteSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /**
   * Mirrors the storage row's `tag` column — equal to `config._tag`.
   * Surfaced on the wire so clients filtering by collector kind don't
   * need to crack the config to discriminate.
   */
  tag: CollectorTag,
  config: CollectorConfig,
  addedAt: Schema.DateTimeUtc,
})

const RemotesSchema = Schema.Array(RemoteSchema)

const CreateRemotePayloadSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  config: CollectorConfig,
})

const UpdateRemotePayloadSchema = Schema.Struct({
  name: Schema.String,
  config: CollectorConfig,
})

const RemoteNotFoundSchema = Schema.Struct({
  error: Schema.Literal('RemoteNotFound'),
  id: Schema.String,
})

/**
 * 400 on create/update when the submitted `config` carries no string `_tag`,
 * so the denormalized `tag` can't be produced. Unreachable through this typed
 * client (which validates the config union before sending), but modeled so the
 * failure is decodable for any non-UI caller.
 */
const InvalidConfigSchema = Schema.Struct({
  error: Schema.Literal('InvalidConfig'),
  message: Schema.String,
})

/**
 * 409 on create when the client-minted id is already taken — a conflict rather
 * than a silent overwrite.
 */
const RemoteAlreadyExistsSchema = Schema.Struct({
  error: Schema.Literal('RemoteAlreadyExists'),
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
      .addError(InvalidConfigSchema, { status: 400 })
      .addError(RemoteAlreadyExistsSchema, { status: 409 })
  )
  .add(
    HttpApiEndpoint.put('UpdateRemote', '/remotes/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .setPayload(UpdateRemotePayloadSchema)
      .addSuccess(RemoteSchema)
      .addError(InvalidConfigSchema, { status: 400 })
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
  InvalidConfigSchema,
  RemoteAlreadyExistsSchema,
}
