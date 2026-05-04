import { Context, Effect, Layer, Schema } from 'effect'
import { Origin } from 'kitchen-sink'

const SmartConfigurationSchema = Schema.Struct({
  issuer: Schema.String,
  jwks_uri: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  token_endpoint_auth_methods_supported: Schema.Array(Schema.String),
  grant_types_supported: Schema.Array(Schema.String),
  registration_endpoint: Schema.String,
  scopes_supported: Schema.Array(Schema.String),
  response_types_supported: Schema.Array(Schema.String),
  management_endpoint: Schema.String,
  introspection_endpoint: Schema.String,
  revocation_endpoint: Schema.String,
  code_challenge_methods_supported: Schema.Array(Schema.String),
  capabilities: Schema.Array(Schema.String),
  associated_endpoints: Schema.Array(Schema.String),
})

class SmartConfiguration extends Context.Tag('SmartConfiguration')<
  SmartConfiguration,
  typeof SmartConfigurationSchema.Type
>() {
  static readonly Schema = SmartConfigurationSchema
}

const makeSmartConfiguration = (origin: string): typeof SmartConfigurationSchema.Type => {
  const host = `${origin}/fhir-r4`
  return SmartConfigurationSchema.make({
    issuer: host,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    authorization_endpoint: `${origin}/auth/authorize`,
    token_endpoint: `${origin}/auth/token`,
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt'],
    grant_types_supported: ['authorization_code', 'client_credentials'],
    registration_endpoint: `${host}/auth/register`,
    scopes_supported: [
      'openid',
      'profile',
      'launch',
      'launch/patient',
      'patient/*.rs',
      'user/*.rs',
      'offline_access',
    ],
    response_types_supported: ['code'],
    management_endpoint: `${host}/user/manage`,
    introspection_endpoint: `${host}/user/introspect`,
    revocation_endpoint: `${host}/user/revoke`,
    code_challenge_methods_supported: ['S256'],
    capabilities: [
      'launch-ehr',
      'permission-patient',
      'permission-v2',
      'client-public',
      'client-confidential-symmetric',
      'context-ehr-patient',
      'sso-openid-connect',
    ],
    associated_endpoints: [],
  })
}

const SmartConfigurationLive = Layer.effect(
  SmartConfiguration,
  Effect.gen(function* () {
    const origin = yield* Origin
    return makeSmartConfiguration(origin)
  })
)

export { SmartConfiguration, SmartConfigurationLive, makeSmartConfiguration }
