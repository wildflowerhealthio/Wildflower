import { createFileRoute, useNavigate, useRouteContext } from '@tanstack/react-router'
import type { JSX } from 'react'
import { useState } from 'react'
import {
  AsyncErrorView,
  ErrorBanner,
  ItemList,
  Menu,
  PageHeader,
  type MenuItem,
} from 'react-tundraish'

import { RevokeGrantDialog } from '../../../components/RevokeGrantDialog.tsx'
import { formatInstant } from '../../../format-date.ts'
import {
  grantsQueryOptions,
  useGrantsQuery,
  useRevokeGrantMutation,
  type AppGrant,
  type DeviceGrant,
  type Grant,
} from '../../../queries/index.ts'
import type { RouterContext } from '../../../router-context.ts'

interface AccessIndexBodyProps {
  readonly grants: readonly Grant[]
}

/** Navigate to the shared per-grant detail route (both variants link here). */
const grantDetailHref = (id: string): string =>
  `/settings/gatekeeper/approved/${encodeURIComponent(id)}`

const AccessIndexBody = ({ grants }: AccessIndexBodyProps): JSX.Element => {
  const navigate = useNavigate()
  const revokeMutation = useRevokeGrantMutation()
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)

  const revoke = (id: string): void => {
    revokeMutation.mutate(
      { id },
      {
        onSuccess: () => {
          setConfirmRevokeId(null)
        },
      }
    )
  }

  // Split the one grants list into its two variants: code-flow grants render as
  // "Approved Apps" (unchanged), device-flow grants as "Authorized Devices".
  const appGrants = grants.filter(
    (grant): grant is AppGrant => grant.grantType === 'authorization_code'
  )
  const deviceGrants = grants.filter(
    (grant): grant is DeviceGrant => grant.grantType === 'device_code'
  )
  const grantToRevoke = grants.find((g) => g.id === confirmRevokeId) ?? null

  return (
    <>
      <PageHeader title="Access" backHref="/settings" backLabel="Settings" />

      <ErrorBanner error={revokeMutation.error} />

      <ItemList
        title="Requests"
        items={[
          {
            id: 'requests',
            title: 'HTTP Requests',
            subtitle: 'View incoming request history',
            onClick: () => {
              void navigate({ to: '/settings/gatekeeper/requests' })
            },
          },
        ]}
      />

      {appGrants.length > 0 ? (
        <ItemList
          title="Approved Apps"
          items={appGrants.map((grant) => ({
            id: grant.id,
            title: grant.clientId,
            subtitle: `${grant.scopes.join(', ')} · Granted ${formatInstant(grant.grantedAt)}`,
            onClick: () => {
              void navigate({ to: grantDetailHref(grant.id) })
            },
            actions: (
              <Menu
                label={`Actions for ${grant.clientId}`}
                items={
                  [
                    {
                      id: 'revoke',
                      label: 'Revoke',
                      destructive: true,
                      onSelect: () => {
                        setConfirmRevokeId(grant.id)
                      },
                    },
                  ] as readonly MenuItem[]
                }
              />
            ),
          }))}
        />
      ) : null}

      <ItemList
        title="Devices"
        items={[
          {
            id: 'devices',
            title: 'Authorize a Device',
            subtitle: 'Enter a code to authorize a device',
            onClick: () => {
              void navigate({ to: '/settings/gatekeeper/devices' })
            },
          },
        ]}
      />

      {/* Durable device pairings minted by the device-code approval flow.
          Revoke UI is intentionally out of scope for v1 — these rows link to
          the shared detail screen but carry no per-row actions yet. */}
      {deviceGrants.length > 0 ? (
        <ItemList
          title="Authorized Devices"
          items={deviceGrants.map((grant) => ({
            id: grant.id,
            title: grant.deviceName,
            subtitle: `${grant.scopes.join(', ')} · Granted ${formatInstant(grant.grantedAt)}`,
            onClick: () => {
              void navigate({ to: grantDetailHref(grant.id) })
            },
          }))}
        />
      ) : null}

      <RevokeGrantDialog
        clientId={grantToRevoke?.clientId ?? null}
        onConfirm={() => {
          if (grantToRevoke !== null) revoke(grantToRevoke.id)
        }}
        onCancel={() => {
          setConfirmRevokeId(null)
        }}
      />
    </>
  )
}

const AccessIndexScreen = (): JSX.Element => {
  const { data: grants } = useGrantsQuery()
  return <AccessIndexBody grants={grants} />
}

interface AccessIndexErrorViewProps {
  readonly error: unknown
  readonly reset: () => void
}

/**
 * The route's `errorComponent`. The Retry button must do more than `reset`
 * (which only clears the `CatchBoundary`'s local error state): it explicitly
 * invalidates the grants query so the suspense query re-runs its `queryFn`
 * instead of replaying the cached rejection. The grants key is derived from
 * `grantsQueryOptions` so it can't drift from what the loader / `useGrantsQuery`
 * read. The annotated `select` keeps the context typed in the standalone
 * (router-not-registered) build — no cast.
 */
const AccessIndexErrorView = ({ error, reset }: AccessIndexErrorViewProps): JSX.Element => {
  const { queryClient, runAuthed } = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => ({
      queryClient: context.queryClient,
      runAuthed: context.runAuthed,
    }),
  })
  const retry = (): void => {
    void queryClient.invalidateQueries({ queryKey: grantsQueryOptions(runAuthed).queryKey })
    reset()
  }
  return <AsyncErrorView error={error} retry={retry} title="Error Loading Gatekeeper Settings" />
}

/**
 * The `/settings/gatekeeper/` landing file route — the owner-facing access
 * management index.
 *
 * The `/settings` `beforeLoad` gate guarantees a token before this loader
 * runs, so it's a plain `ensureQueryData` — failures propagate to
 * `errorComponent`.
 */
const Route = createFileRoute('/settings/gatekeeper/')({
  loader: ({ context }) =>
    context.queryClient.query({ ...grantsQueryOptions(context.runAuthed), staleTime: 'static' }),
  component: AccessIndexScreen,
  errorComponent: ({ error, reset }) => <AccessIndexErrorView error={error} reset={reset} />,
})

export { AccessIndexBody, AccessIndexErrorView, Route }
