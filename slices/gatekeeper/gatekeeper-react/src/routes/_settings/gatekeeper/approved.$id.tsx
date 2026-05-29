import { createRoute, type AnyRoute } from '@tanstack/react-router'
import { Effect } from 'effect'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { Suspense, useMemo, type JSX } from 'react'
import { Awaited, pageLayoutStyles, PageLoading } from 'react-tundraish'
import { useRouteParams } from 'shared-structures-react'

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

const approvedAppDetailPath = '/settings/gatekeeper/approved/$id'

/**
 * Builds the `/settings/gatekeeper/approved/$id` route under an app-provided
 * parent. The component closure reads `$id` via `useRouteParams`, which
 * reconstructs the param shape from the path literal (`$id` → `{ id: string }`)
 * and hands it to the screen as a prop.
 */
export const makeApprovedAppDetailRoute = <TParent extends AnyRoute>(
  getParentRoute: () => TParent
  // oxlint-disable-next-line typescript/explicit-function-return-type
) => {
  const route = createRoute({
    getParentRoute,
    path: approvedAppDetailPath,
    component: function ApprovedAppDetailRoute() {
      const { id } = useRouteParams(route, approvedAppDetailPath)
      return <ApprovedAppDetailScreen id={id} />
    },
  })
  return route
}
