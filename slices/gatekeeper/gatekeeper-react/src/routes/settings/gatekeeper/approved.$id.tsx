import { createFileRoute } from '@tanstack/react-router'
import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { Suspense, useMemo, type JSX } from 'react'
import { Awaited, pageLayoutStyles, PageLoading } from 'react-tundraish'

import { useGatekeeperEffect } from '../../../gatekeeper-client.tsx'
import styles from './approved.$id.module.css'

function ApprovedAppDetailScreen({ id }: { readonly id: string }): JSX.Element {
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

/**
 * The `/settings/gatekeeper/approved/$id` file route. Reads the typed `$id`
 * path param from the generated route via `Route.useParams()` and hands it
 * to the screen as a prop.
 */
function ApprovedAppDetailRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <ApprovedAppDetailScreen id={id} />
}

export const Route = createFileRoute('/settings/gatekeeper/approved/$id')({
  component: ApprovedAppDetailRoute,
})
