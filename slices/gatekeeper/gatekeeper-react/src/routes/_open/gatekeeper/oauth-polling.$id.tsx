// This file route must keep its `export const Route` (the tanstackRouter
// plugin keys off it), and `PollingResult` is exported separately as a
// unit-test seam — so a consolidated single export isn't possible here.
/* oxlint-disable import/group-exports -- file route needs `export const Route`; `PollingResult` is a test seam */
import { createFileRoute } from '@tanstack/react-router'
import { type AuthorizationStatus, pollAuthorizationStatus } from 'gatekeeper-core/clients'
import { Suspense, useEffect, useMemo, type JSX } from 'react'
import { cn, useStream } from 'react-kitchen-sink'
import { AsyncErrorView, Awaited } from 'react-tundraish'

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
      {/*
        Unlike the query routes, this one surfaces a read failure through
        the inline `<Awaited errorTitle>` boundary, NOT a route
        `errorComponent`. The route has no `loader` — the data is a
        long-lived `Stream` whose rejection is delivered as the promise
        this `<Awaited>` boundary owns, so a route `errorComponent` (which
        fires for loader/beforeLoad failures) would never see it. Keep the
        inline boundary; don't "fix" it into an `errorComponent`.
      */}
      <Awaited
        promise={statusPromise}
        resetKey={id}
        errorComponent={(error) => (
          <div className={styles['poll']}>
            <AsyncErrorView
              error={error}
              title="Authorization Error"
              titleClassName={pageLayout['poll-declined']}
            />
          </div>
        )}
      >
        {(status) => <PollingResult status={status} />}
      </Awaited>
    </Suspense>
  )
}

interface PollingResultProps {
  readonly status: AuthorizationStatus
}

// Exported for unit tests: the deterministic status→view mapping each
// stream emission flows into, tested directly without the Suspense/fiber
// timing of the full stream subscription.
export const PollingResult = ({ status }: PollingResultProps): JSX.Element => {
  useEffect(() => {
    if (status.status === 'approved') {
      window.location.replace(status.redirect)
    }
  }, [status])

  if (status.status === 'denied') {
    return (
      <div className={styles['poll']}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-6')}>Request Declined</h1>
        <p className="text-body-2">The authorization request was declined.</p>
      </div>
    )
  }
  if (status.status === 'error') {
    return (
      <div className={styles['poll']}>
        <h1 className={cn(pageLayout['poll-declined'], 'text-heading-6')}>Authorization Error</h1>
        <p className="text-body-2">{status.message}</p>
      </div>
    )
  }
  // Pending heartbeat or post-approved-pre-redirect — same spinner.
  return <PollingSpinner />
}

const PollingSpinner = (): JSX.Element => (
  <div className={styles['poll']}>
    <div className={styles['poll-spinner']} />
    <h1 className="text-heading-6">Waiting for Approval</h1>
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
