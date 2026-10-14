import type { JSX } from 'react'

import { useOAuthConsentMutation } from '../../queries/index.ts'
import type { OAuthConsentResource, OAuthConsentResult } from '../../queries/index.ts'
import { consentAsksForPatient } from './consent-asks-for-patient.ts'
import { OAuthConsentCard } from './oauth-consent-card.tsx'
import { usePatientOptions } from './use-patient-options.ts'

interface OAuthConsentFormProps {
  readonly consent: OAuthConsentResource
  readonly onDone: (result: OAuthConsentResult) => void
}

/**
 * The {@link OAuthConsentCard} on the router's authed runner: the decision goes
 * through {@link useOAuthConsentMutation}, and the patient bar lists the
 * server's patients through `fhir-r4-react`, read only when the consent asks
 * for a patient.
 */
const OAuthConsentForm = ({ consent, onDone }: OAuthConsentFormProps): JSX.Element => {
  const consentMutation = useOAuthConsentMutation()
  const patients = usePatientOptions(consentAsksForPatient(consent))
  return (
    <OAuthConsentCard
      consent={consent}
      consentMutation={consentMutation}
      patients={patients}
      onDone={onDone}
    />
  )
}

export { OAuthConsentForm }
export type { OAuthConsentFormProps }
