import type { Schema } from 'effect'
import type { OAuthConsent } from 'gatekeeper-core/http-api-definition'

type Consent = Schema.Schema.Type<typeof OAuthConsent.OAuthConsentSchema>

interface PatientOption {
  readonly id: string
  readonly displayName: string
}

export type { Consent, PatientOption }
