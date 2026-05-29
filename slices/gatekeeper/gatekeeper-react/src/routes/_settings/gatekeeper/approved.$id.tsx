/* oxlint-disable react/only-export-components, typescript/no-unsafe-assignment -- typed via createFileRoute and a slice-local routeTree.gen.ts augmentation; oxlint type inference does not pick it up */

import { createFileRoute } from '@tanstack/react-router'
import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { Suspense, useMemo, type JSX } from 'react'
import { Awaited, pageLayoutStyles, PageLoading } from 'react-tundraish'

import { useGatekeeperEffect } from '../../../gatekeeper-client.tsx'
import styles from './approved.$id.module.css'

function ApprovedAppDetailScreen(): JSX.Element {
  const { id } = Route.useParams()

  const grantEffect = useMemo(
    () =>
      Effect.flatMap(GatekeeperHttpApiClient, (c) =>
        c['access-management'].GetGrant({ path: { id } })
      ),
    [id]
  )

  const grantPromise = useGatekeeperEffect(grantEffect)

  return (
    <Suspense fallback={<PageLoading />}>
      <Awaited promise={grantPromise} resetKey={id} errorTitle="Not Found">
        {(grant) => (
          <div className={pageLayoutStyles['page']}>
            <h1 className="text-heading-4">{grant.clientId}</h1>
            <pre className={styles['json']}>{JSON.stringify(grant, null, 2)}</pre>
          </div>
        )}
      </Awaited>
    </Suspense>
  )
}

export const Route = createFileRoute('/settings/gatekeeper/approved/$id')({
  component: ApprovedAppDetailScreen,
})
