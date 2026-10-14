import { Scope, ScopeRequest } from '@wildflowerhealthio/scopes-core'

import type { OAuthConsentResource } from '../../queries/index.ts'

/**
 * Whether `consent` asks for a launch patient: it requests a FHIR
 * patient-context scope or `launch/patient`. The card shows its patient bar only
 * then, so its composer reads the patients only then.
 */
const consentAsksForPatient = (consent: OAuthConsentResource): boolean => {
  const request = ScopeRequest.fromRequestedScopes({ optional: consent.scopes })
  return (
    Scope.MultiScope.fhirScopes(request.requested).some((scope) =>
      scope.hasContext(Scope.Contexts.Fhir.patient)
    ) || request.requested.known.some((known) => known.name === 'launch/patient')
  )
}

export { consentAsksForPatient }
