import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { Suspense, useMemo, type JSX } from 'react'
import { Await, useNavigate, useParams } from 'react-router'
import { AsyncErrorView, PageLoading } from 'react-tundraish'

import { useGatekeeperEffect, useGatekeeperEffectAction } from '../../gatekeeper-client.tsx'
import { OAuthConsentForm } from './oauth-consent-form.tsx'
import type { Consent } from './types.ts'

const OAuthConsentScreen = (): JSX.Element => {
  const runGatekeeper = useGatekeeperEffectAction()
  const navigate = useNavigate()
  const { id = '' } = useParams<{ id: string }>()

  const consentEffect = useMemo(
    () =>
      Effect.flatMap(GatekeeperHttpApiClient, (c) =>
        c['oauth-consent'].GetOAuthConsent({ path: { id } })
      ),
    [id]
  )

  const consentPromise = useGatekeeperEffect(consentEffect)

  return (
    <Suspense fallback={<PageLoading />}>
      <Await
        resolve={consentPromise}
        errorElement={<AsyncErrorView title="Authorization Request" />}
      >
        {(consent: Consent) => (
          <OAuthConsentForm
            runGatekeeper={runGatekeeper}
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
