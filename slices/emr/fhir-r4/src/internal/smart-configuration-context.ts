import { Context, Effect, Layer, Schema } from 'effect'
import { Origin } from 'kitchen-sink'

// Per the SMART App Launch IG (https://hl7.org/fhir/smart-app-launch/conformance.html#metadata)
// only `authorization_endpoint`, `token_endpoint`, `grant_types_supported`,
// `capabilities`, and `code_challenge_methods_supported` are unconditionally
// required. `issuer` / `jwks_uri` are required only when SSO is supported;
// the others are optional. We keep `issuer` and `jwks_uri` required here
// because the current implementation always populates them, but the rest
// are optional so spec-conformant configs that omit (e.g.) `management_endpoint`
// still parse.
const SmartConfigurationSchema = Schema.Struct({
  issuer: Schema.String,
  jwks_uri: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  grant_types_supported: Schema.Array(Schema.String),
  code_challenge_methods_supported: Schema.Array(Schema.String),
  capabilities: Schema.Array(Schema.String),
  token_endpoint_auth_methods_supported: Schema.optional(Schema.Array(Schema.String)),
  registration_endpoint: Schema.optional(Schema.String),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
  response_types_supported: Schema.optional(Schema.Array(Schema.String)),
  management_endpoint: Schema.optional(Schema.String),
  introspection_endpoint: Schema.optional(Schema.String),
  revocation_endpoint: Schema.optional(Schema.String),
  associated_endpoints: Schema.optional(Schema.Array(Schema.String)),
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
