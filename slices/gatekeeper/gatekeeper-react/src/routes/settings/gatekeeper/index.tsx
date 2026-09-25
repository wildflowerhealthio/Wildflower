import { createFileRoute, useNavigate, useRouteContext } from '@tanstack/react-router'
import { constVoid } from 'effect/Function'
import type { JSX } from 'react'
import { useState } from 'react'
import {
  AsyncErrorView,
  ConfirmDialog,
  ErrorBanner,
  ItemList,
  Menu,
  PageHeader,
  type MenuItem,
} from 'react-tundraish'

import { TrustedAppsSection } from '../../../components/TrustedAppsSection.tsx'
import { formatInstant } from '../../../format-date.ts'
import {
  clientsQueryOptions,
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

  // The dialog closes once the revoke settles either way, so a failure shows
  // in the error banner rather than behind the modal.
  const revoke = (id: string): void => {
    revokeMutation.mutate(
      { id },
      {
        onSettled: () => {
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
                  // One revoke at a time: held while one is in flight.
                  [
                    revokeMutation.isPending
                      ? { id: 'revoke', label: 'Revoke', disabled: true }
                      : {
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

      {/* Every client the Owner trusts (seeded, or trusted on first use from a
          consent prompt), with the switch that takes that trust back. Loads
          and fails on its own, apart from the grants above. */}
      <TrustedAppsSection />

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

      <ConfirmDialog
        open={grantToRevoke !== null}
        title="Revoke Access"
        confirmLabel="Revoke"
        destructive
        pending={revokeMutation.isPending}
        onConfirm={() => {
          if (grantToRevoke !== null) revoke(grantToRevoke.id)
        }}
        onCancel={() => {
          setConfirmRevokeId(null)
        }}
      >
        Are you sure you want to revoke access for &quot;{grantToRevoke?.clientId ?? ''}&quot;?
      </ConfirmDialog>
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
 * instead of replaying a cached rejection. The key is derived from
 * `grantsQueryOptions` so it can't drift from what the loader and the hook
 * read. (A clients failure never lands here — `TrustedAppsSection` catches
 * it.) The annotated `select` keeps the context typed in the standalone
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
 * runs. It waits only on the grants — their failure propagates to
 * `errorComponent`. The clients list is prefetched but not waited on:
 * `TrustedAppsSection` suspends on it and catches its failure itself, so a
 * session that can read grants but not clients still gets the page.
 */
const Route = createFileRoute('/settings/gatekeeper/')({
  loader: async ({ context }) => {
    // Not awaited, and its rejection dropped here only: the failure stays in
    // the query's state, where `TrustedAppsSection` suspends on it and shows it.
    context.queryClient
      .query({ ...clientsQueryOptions(context.runAuthed), staleTime: 'static' })
      .catch(constVoid)
    await context.queryClient.query({
      ...grantsQueryOptions(context.runAuthed),
      staleTime: 'static',
    })
  },
  component: AccessIndexScreen,
  errorComponent: ({ error, reset }) => <AccessIndexErrorView error={error} reset={reset} />,
})

export { AccessIndexBody, AccessIndexErrorView, Route }
