import { HttpApiEndpoint, HttpApiError, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

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

const httpApiGroup = HttpApiGroup.make('smart-well-known', { topLevel: false })
  .add(
    HttpApiEndpoint.get('SmartConfiguration', '/smart-configuration')
      .addSuccess(SmartConfigurationSchema)
      .addError(HttpApiError.Forbidden)
  )
  .prefix('/.well-known')

export { httpApiGroup, SmartConfigurationSchema }
