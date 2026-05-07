import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { Suspense, useMemo, type JSX } from 'react'
import { useEffectTs } from 'react-kitchen-sink'
import { Await, useNavigate, useParams } from 'react-router'

import { AsyncErrorView } from '../../components/AsyncErrorView.tsx'
import { PageLoading } from '../../components/PageLoading.tsx'
import { useGatekeeperClient } from '../../use-gatekeeper-client.ts'
import { OAuthConsentForm } from './oauth-consent-form.tsx'
import type { Consent } from './types.ts'

/**
 * Suspense + `Await` pattern: the consent fetch is a single Effect
 * run through the session runtime, returning a stable Promise (via
 * `useEffectTs`). The form's approve/decline actions stay
 * imperative — they fire once on click, navigate away on success.
 */
const OAuthConsentScreen = (): JSX.Element => {
  const session = useGatekeeperClient()
  const navigate = useNavigate()
  const { id = '' } = useParams<{ id: string }>()

  const consentEffect = useMemo(
    () =>
      Effect.flatMap(GatekeeperHttpApiClient, (c) =>
        c['oauth-consent'].GetOAuthConsent({ path: { id } })
      ),
    [id]
  )

  const consentPromise = useEffectTs(consentEffect, session.runtime)

  return (
    <Suspense fallback={<PageLoading />}>
      <Await
        resolve={consentPromise}
        errorElement={<AsyncErrorView title="Authorization Request" />}
      >
        {(consent: Consent) => (
          <OAuthConsentForm
            session={session}
            consent={consent}
            onDone={() => {
              void navigate('/gatekeeper', { replace: true })
            }}
          />
        )}
      </Await>
    </Suspense>
  )
}

export { OAuthConsentScreen }
