import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { Suspense, useMemo, type JSX } from 'react'
import { Await, useNavigate, useParams } from 'react-router'
import { useEffectTs } from 'telemetry-react'

import { AsyncErrorView } from '../../components/AsyncErrorView.tsx'
import { PageLoading } from '../../components/PageLoading.tsx'
import { useGatekeeperClientLayer } from '../../use-gatekeeper-client-layer.ts'
import { OAuthConsentForm } from './oauth-consent-form.tsx'
import type { Consent } from './types.ts'

const OAuthConsentScreen = (): JSX.Element => {
  const layer = useGatekeeperClientLayer()
  const navigate = useNavigate()
  const { id = '' } = useParams<{ id: string }>()

  const consentEffect = useMemo(
    () =>
      Effect.flatMap(GatekeeperHttpApiClient, (c) =>
        c['oauth-consent'].GetOAuthConsent({ path: { id } })
      ).pipe(Effect.provide(layer)),
    [layer, id]
  )

  const consentPromise = useEffectTs(consentEffect)

  return (
    <Suspense fallback={<PageLoading />}>
      <Await
        resolve={consentPromise}
        errorElement={<AsyncErrorView title="Authorization Request" />}
      >
        {(consent: Consent) => (
          <OAuthConsentForm
            layer={layer}
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
