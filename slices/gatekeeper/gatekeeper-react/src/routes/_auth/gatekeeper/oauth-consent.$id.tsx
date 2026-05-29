/* oxlint-disable react/only-export-components -- file-based route file exports `Route` alongside the component */

import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { Suspense, useMemo, type JSX } from 'react'
import { Awaited, PageLoading } from 'react-tundraish'

import { useGatekeeperEffect, useGatekeeperEffectAction } from '../../../gatekeeper-client.tsx'
import { OAuthConsentForm } from '../../../screens/oauth-consent/oauth-consent-form.tsx'

function OAuthConsentScreen(): JSX.Element {
  const runGatekeeper = useGatekeeperEffectAction()
  const navigate = useNavigate()
  const { id }: { id: string } = Route.useParams()

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
      <Awaited promise={consentPromise} resetKey={id} errorTitle="Authorization Request">
        {(consent) => (
          <OAuthConsentForm
            runGatekeeper={runGatekeeper}
            consent={consent}
            onDone={() => {
              void navigate({ to: '/settings/gatekeeper' })
            }}
          />
        )}
      </Awaited>
    </Suspense>
  )
}

export const Route = createFileRoute('/gatekeeper/oauth-consent/$id')({
  component: OAuthConsentScreen,
})
