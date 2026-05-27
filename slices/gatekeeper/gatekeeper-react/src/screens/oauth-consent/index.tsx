import { useNavigate, useParams } from '@tanstack/react-router'
import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { Suspense, useMemo, type JSX } from 'react'
import { Awaited, PageLoading } from 'react-tundraish'

import { useGatekeeperEffect, useGatekeeperEffectAction } from '../../gatekeeper-client.tsx'
import { OAuthConsentForm } from './oauth-consent-form.tsx'
import type { Consent } from './types.ts'

const OAuthConsentScreen = (): JSX.Element => {
  const runGatekeeper = useGatekeeperEffectAction()
  const navigate = useNavigate()
  // `strict: false`: see `oauth-polling.tsx` for the rationale.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see oauth-polling.tsx
  const { id = '' } = useParams({ strict: false }) as unknown as { readonly id?: string }

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
        {(consent: Consent) => (
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

export { OAuthConsentScreen }
