import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { Client } from '@wildflowerhealthio/authorization-core/domain'
import {
  clientsQueryOptions,
  formatInstant,
  grantsQueryOptions,
  TrustedAppsSection,
  useGrantsQuery,
  useRevokeGrantMutation,
  type AppGrant,
  type DeviceGrant,
  type Grant,
} from '@wildflowerhealthio/authorization-react'
import {
  AsyncErrorView,
  ConfirmDialog,
  ErrorBanner,
  ItemList,
  Menu,
  PageHeader,
  type MenuItem,
} from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'
import { useState } from 'react'

import { AUTHORIZATION_CLIENT_ID } from './config.ts'
import type { RouterContext } from './router-context.ts'
import styles from './access-page.module.css'

/**
 * The ids of the clients whose grants the page offers no Revoke for:
 *
 * - the first-party host client, which is how the Owner reaches the server at
 *   all. The server refuses to disable that client (`409
 *   FirstPartyClientLocked`), and revoking its grant would cut the Owner off
 *   the same way;
 * - this app's own client, whose revocation would revoke the bearer the page
 *   is signed in with.
 *
 * `null` until the trusted apps have loaded, so no Revoke shows before the
 * page knows which clients are locked.
 */
const lockedClientIdsOf = (
  clients: readonly Client.Type[] | undefined
): ReadonlySet<string> | null =>
  clients === undefined
    ? null
    : new Set([
        AUTHORIZATION_CLIENT_ID,
        ...clients.filter((client) => client.firstParty).map((client) => client.clientId),
      ])

interface AccessPageBodyProps {
  readonly serverUrl: string
  readonly grants: readonly Grant[]
}

/**
 * The server's access, in three lists:
 *
 * - **Approved Apps**: the authorization-code grants, each with a Revoke
 *   (confirmed), which deletes the grant and then revokes every token its
 *   client holds;
 * - **Trusted Apps**: every client the server trusts, with the switch that
 *   disables or enables one ({@link TrustedAppsSection});
 * - **Authorized Devices**: the device-code grants, read only.
 *
 * The first-party host client's grants and switch are not offered: the server
 * refuses to disable that client, and the Owner reaches the server through it.
 * Nor is a Revoke for this app's own grant, which would sign the page out.
 */
const AccessPageBody = ({ serverUrl, grants }: AccessPageBodyProps): JSX.Element => {
  const navigate = useNavigate()
  const runAuthed = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runAuthed,
  })
  const { data: clients } = useQuery(clientsQueryOptions(runAuthed))
  const lockedClientIds = lockedClientIdsOf(clients)
  const revokeMutation = useRevokeGrantMutation()
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)

  // The dialog closes once the revoke settles either way, so a failure shows
  // in the error banner rather than behind the modal.
  const revoke = (grant: AppGrant): void => {
    revokeMutation.mutate(
      { id: grant.id, clientId: grant.clientId },
      {
        onSettled: () => {
          setConfirmRevokeId(null)
        },
      }
    )
  }

  const appGrants = grants.filter(
    (grant): grant is AppGrant => grant.grantType === 'authorization_code'
  )
  const deviceGrants = grants.filter(
    (grant): grant is DeviceGrant => grant.grantType === 'device_code'
  )
  const grantToRevoke = appGrants.find((grant) => grant.id === confirmRevokeId) ?? null

  /** The Revoke menu for `grant`, or none for a locked client's grant. */
  const revokeMenuFor = (grant: AppGrant): JSX.Element | null => {
    if (lockedClientIds === null || lockedClientIds.has(grant.clientId)) return null
    // One revoke at a time: held while one is in flight.
    const revokeItem: MenuItem = revokeMutation.isPending
      ? { id: 'revoke', label: 'Revoke', disabled: true }
      : {
          id: 'revoke',
          label: 'Revoke',
          destructive: true,
          onSelect: () => {
            setConfirmRevokeId(grant.id)
          },
        }
    return (
      <Menu
        label={`Actions for ${Client.displayName(clients, grant.clientId)}`}
        items={[revokeItem]}
      />
    )
  }

  return (
    <>
      <PageHeader title="Access" />
      <p className={styles['access-page__server']}>
        Managing <span className={styles['access-page__server-url']}>{serverUrl}</span>
      </p>

      <ErrorBanner error={revokeMutation.error} />

      {appGrants.length > 0 ? (
        <ItemList
          title="Approved Apps"
          items={appGrants.map((grant) => {
            const actions = revokeMenuFor(grant)
            return {
              id: grant.id,
              title: Client.displayName(clients, grant.clientId),
              subtitle: `Granted ${formatInstant(grant.grantedAt)} · ${grant.scopes.join(', ')}`,
              onClick: () => {
                void navigate({ to: '/approved/$id', params: { id: grant.id } })
              },
              ...(actions === null ? {} : { actions }),
            }
          })}
        />
      ) : null}

      {/* Every client the server trusts (seeded, or trusted on first use from a
          consent prompt), with the switch that takes that trust back. Loads
          and fails on its own, apart from the grants above. */}
      <TrustedAppsSection />

      {deviceGrants.length > 0 ? (
        <ItemList
          title="Authorized Devices"
          items={deviceGrants.map((grant) => ({
            id: grant.id,
            title: grant.deviceName,
            subtitle: `Granted ${formatInstant(grant.grantedAt)} · ${grant.scopes.join(', ')}`,
            onClick: () => {
              void navigate({ to: '/approved/$id', params: { id: grant.id } })
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
          if (grantToRevoke !== null) revoke(grantToRevoke)
        }}
        onCancel={() => {
          setConfirmRevokeId(null)
        }}
      >
        Revoke access for &quot;
        {grantToRevoke === null ? '' : Client.displayName(clients, grantToRevoke.clientId)}&quot;?
        Every token it holds stops working now.
      </ConfirmDialog>
    </>
  )
}

/** The access page over the grants its loader warmed. */
const AccessPage = (): JSX.Element => {
  const serverUrl = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.session.serverUrl,
  })
  const { data: grants } = useGrantsQuery()
  return <AccessPageBody serverUrl={serverUrl} grants={grants} />
}

interface AccessPageErrorProps {
  readonly error: unknown
  readonly reset: () => void
}

/**
 * The access route's `errorComponent`. Retry invalidates the grants query
 * before `reset`, so the suspense query fetches again instead of replaying the
 * cached rejection.
 */
const AccessPageError = ({ error, reset }: AccessPageErrorProps): JSX.Element => {
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
  return <AsyncErrorView error={error} retry={retry} title="Error Loading Access" />
}

export { AccessPage, AccessPageBody, AccessPageError }
