import { createRoute, useNavigate, type AnyRoute } from '@tanstack/react-router'
import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { Suspense, useMemo, type JSX } from 'react'
import { Awaited, PageLoading } from 'react-tundraish'
import { useRouteParams } from 'shared-structures-react'

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

const oAuthConsentPath = '/gatekeeper/oauth-consent/$id'

/**
 * Builds the `/gatekeeper/oauth-consent/$id` route under an app-provided
 * parent. The component closure reads `$id` via `useRouteParams`, which
 * reconstructs the param shape from the path literal (`$id` → `{ id: string }`)
 * and hands it to the screen as a prop.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export const makeOAuthConsentRoute = <TParent extends AnyRoute>(getParentRoute: () => TParent) => {
  const route = createRoute({
    getParentRoute,
    path: oAuthConsentPath,
    component: function OAuthConsentRoute() {
      const { id } = useRouteParams(route, oAuthConsentPath)
      return <OAuthConsentScreen id={id} />
    },
  })
  return route
}
