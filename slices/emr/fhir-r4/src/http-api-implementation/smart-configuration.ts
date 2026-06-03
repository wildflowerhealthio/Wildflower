import { HttpApiBuilder, HttpApiError } from '@effect/platform'
import { Effect } from 'effect'
import { requestOriginFromHttpRequest } from 'navigation-core'

import { FhirPublicApi } from '../http-api-definition/index.ts'
import { SmartConfigurationSchema } from '../http-api-definition/smart-configuration.ts'

const layer = HttpApiBuilder.group(FhirPublicApi, 'smart-well-known', (handlers) =>
  handlers.handle('SmartConfiguration', () =>
    Effect.map(requestOriginFromHttpRequest, (origin) => {
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
    }).pipe(
      Effect.catchTag('UntrustedRemotePeer', () => Effect.fail(new HttpApiError.Forbidden()))
    )
  )
)

export { layer }
