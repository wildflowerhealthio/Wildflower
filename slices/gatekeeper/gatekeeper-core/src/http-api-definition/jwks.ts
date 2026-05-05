import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

const JwksSchema = Schema.Struct({
  keys: Schema.Array(Schema.Unknown),
})

const httpApiGroup = HttpApiGroup.make('auth-well-known', { topLevel: false })
  .add(HttpApiEndpoint.get('JwksJson', '/jwks.json').addSuccess(JwksSchema))
  .prefix('/.well-known')

export { httpApiGroup }
