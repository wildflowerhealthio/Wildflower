import { createRoute, type AnyRoute } from '@tanstack/react-router'
import { type AuthorizationStatus, pollAuthorizationStatus } from 'gatekeeper-core/clients'

import { Suspense, useEffect, useMemo, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Awaited, pageLayoutStyles } from 'react-tundraish'
import { useRouteParams } from 'shared-structures-react'

import { useGatekeeperStream } from '../../../gatekeeper-client.tsx'
import pageLayout from '../../../styles/page-layout.module.css'
import styles from './oauth-polling.module.css'

/**
 * SPA route that subscribes to `pollAuthorizationStatus(id)` and renders
 * the latest emission. The polling endpoint is public — but the runner
 * pipes through the same `BearerToken` plumbing as authed routes (which
 * resolves to `null` here and adds no header).
 */
function OAuthPollingScreen({ id }: { readonly id: string }): JSX.Element {
  const stream = useMemo(() => pollAuthorizationStatus(id), [id])
  const statusPromise = useGatekeeperStream(stream)

  return (
    <Suspense fallback={<PollingSpinner />}>
      <Awaited
        promise={statusPromise}
        resetKey={id}
        errorTitle="Authorization Error"
        errorClassName={styles['poll']}
        errorTitleClassName={pageLayout['poll-declined']}
      >
        {(status) => <PollingResult status={status} />}
      </Awaited>
    </Suspense>
  )
}

interface PollingResultProps {
  readonly status: AuthorizationStatus
}

const PollingResult = ({ status }: PollingResultProps): JSX.Element => {
  useEffect(() => {
    if (status.status === 'approved') {
      window.location.replace(status.redirect)
    }
  }, [status])

  if (status.status === 'denied') {
    return (
      <div className={cn(pageLayoutStyles['page'], styles['poll'])}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Request Declined</h1>
        <p className="text-body-2">The authorization request was declined.</p>
      </div>
    )
  }
  if (status.status === 'error') {
    return (
      <div className={cn(pageLayoutStyles['page'], styles['poll'])}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-4')}>Authorization Error</h1>
        <p className="text-body-2">{status.message}</p>
      </div>
    )
  }
  // Pending heartbeat or post-approved-pre-redirect — same spinner.
  return <PollingSpinner />
}

const PollingSpinner = (): JSX.Element => (
  <div className={cn(pageLayoutStyles['page'], styles['poll'])}>
    <div className={styles['poll-spinner']} />
    <h1 className="text-heading-4">Waiting for Approval</h1>
    <p className="text-body-2">Please approve this request on your device.</p>
  </div>
)

const oAuthPollingPath = '/gatekeeper/oauth-polling/$id'

/**
 * Builds the `/gatekeeper/oauth-polling/$id` route under an app-provided
 * parent. The component closure reads `$id` via `useRouteParams`, which
 * reconstructs the param shape from the path literal (`$id` → `{ id: string }`)
 * and hands it to the screen as a prop.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export const makeOAuthPollingRoute = <TParent extends AnyRoute>(getParentRoute: () => TParent) => {
  const route = createRoute({
    getParentRoute,
    path: oAuthPollingPath,
    component: function OAuthPollingRoute() {
      const { id } = useRouteParams(route, oAuthPollingPath)
      return <OAuthPollingScreen id={id} />
    },
  })
  return route
}
