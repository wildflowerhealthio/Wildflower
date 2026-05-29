import { createFileRoute } from '@tanstack/react-router'
import { type AuthorizationStatus, pollAuthorizationStatus } from 'gatekeeper-core/clients'
import { Suspense, useEffect, useMemo, type JSX } from 'react'
import { cn, useStream } from 'react-kitchen-sink'
import { Awaited, pageLayoutStyles } from 'react-tundraish'

import { useGatekeeperRuntimeLayer } from '../../../router-context.ts'
import pageLayout from '../../../styles/page-layout.module.css'
import styles from './oauth-polling.module.css'

/**
 * SPA route that subscribes to `pollAuthorizationStatus(id)` and renders
 * the latest emission. This is a long-lived `Stream` (it emits `pending`
 * heartbeats until a terminal status), not a one-shot read, so it runs
 * through `react-kitchen-sink`'s generic `useStream` against the
 * composed `runtimeLayer` from router context — NOT a one-shot TanStack
 * query. The polling endpoint is public, but the layer pipes through the
 * same `BearerToken` plumbing as authed routes (which resolves to `null`
 * here and adds no header).
 */
function OAuthPollingScreen({ id }: { readonly id: string }): JSX.Element {
  const runtimeLayer = useGatekeeperRuntimeLayer()
  const stream = useMemo(() => pollAuthorizationStatus(id), [id])
  const statusPromise = useStream(stream, runtimeLayer)

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

/**
 * The `/gatekeeper/oauth-polling/$id` file route. Reads the typed `$id`
 * path param from the generated route via `Route.useParams()` and hands it
 * to the screen as a prop.
 */
function OAuthPollingRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <OAuthPollingScreen id={id} />
}

export const Route = createFileRoute('/_open/gatekeeper/oauth-polling/$id')({
  component: OAuthPollingRoute,
})
