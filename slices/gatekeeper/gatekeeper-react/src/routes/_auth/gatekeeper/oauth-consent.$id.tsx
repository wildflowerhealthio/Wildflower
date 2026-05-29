import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { Suspense, useMemo, type JSX } from 'react'
import { Awaited, PageLoading } from 'react-tundraish'

import { useGatekeeperEffect, useGatekeeperEffectAction } from '../../../gatekeeper-client.tsx'
import { OAuthConsentForm } from '../../../screens/oauth-consent/oauth-consent-form.tsx'

function OAuthConsentScreen({ id }: { readonly id: string }): JSX.Element {
  const runGatekeeper = useGatekeeperEffectAction()
  const navigate = useNavigate()

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

/**
 * The `/gatekeeper/oauth-consent/$id` file route. Reads the typed `$id`
 * path param from the generated route via `Route.useParams()` and hands it
 * to the screen as a prop.
 */
function OAuthConsentRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <OAuthConsentScreen id={id} />
}

export const Route = createFileRoute('/_auth/gatekeeper/oauth-consent/$id')({
  component: OAuthConsentRoute,
})
