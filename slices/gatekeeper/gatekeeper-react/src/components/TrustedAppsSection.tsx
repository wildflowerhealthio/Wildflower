import { QueryErrorResetBoundary, useQueryErrorResetBoundary } from '@tanstack/react-query'
import { CatchBoundary, type ErrorComponentProps } from '@tanstack/react-router'
import type { JSX } from 'react'
import { Suspense, useState } from 'react'
import {
  AsyncErrorView,
  ConfirmDialog,
  ErrorBanner,
  ItemList,
  Menu,
  type MenuItem,
} from 'react-tundraish'

import { useClientsQuery, useUpdateClientMutation, type Client } from '../queries/index.ts'
import { trustedAppRow, type TrustedAppRow } from './trusted-app-row.ts'

/**
 * The Access screen's "Trusted Apps" section, loaded on its own: it suspends
 * on the clients query and catches that query's failure (e.g. a `403` for a
 * session without `wildflower/Client.r`) in place, with a Retry, so the rest
 * of the screen — grants included — still renders.
 */
const TrustedAppsSection = (): JSX.Element => (
  <QueryErrorResetBoundary>
    <CatchBoundary getResetKey={() => 0} errorComponent={TrustedAppsLoadError}>
      <Suspense fallback={null}>
        <LoadedTrustedApps />
      </Suspense>
    </CatchBoundary>
  </QueryErrorResetBoundary>
)

/** The section's failed load, with a Retry that fetches the clients again. */
const TrustedAppsLoadError = ({ error, reset }: ErrorComponentProps): JSX.Element => {
  const { reset: resetFailedQueries } = useQueryErrorResetBoundary()
  return (
    <AsyncErrorView
      error={error}
      title="Error Loading Trusted Apps"
      retry={() => {
        // Clear the failed query's error first, so the remounted suspense
        // query fetches again instead of re-throwing it.
        resetFailedQueries()
        reset()
      }}
    />
  )
}

const LoadedTrustedApps = (): JSX.Element | null => {
  const { data: clients } = useClientsQuery()
  return <TrustedAppsList clients={clients} />
}

interface TrustedAppsListProps {
  readonly clients: readonly Client[]
}

/**
 * The Owner's "Trusted Apps" list — every registered OAuth client, seeded or
 * trusted on first use — with a per-row Disable (confirmed) / Enable switch
 * that PATCHes the client's `disabledAt`. Disabling takes the Owner's trust
 * back at once: the app can't sign in or refresh until it's enabled again.
 * The first-party host offers no switch.
 *
 * One switch at a time: while a disable/enable is in flight every row's
 * switch, and the dialog's Disable, is held. The confirm dialog closes once
 * the request settles either way, so a failure shows in the error banner
 * rather than behind the modal. The list only changes once the server
 * confirms (no optimistic update), via the clients-list invalidation.
 */
const TrustedAppsList = ({ clients }: TrustedAppsListProps): JSX.Element | null => {
  const mutation = useUpdateClientMutation()
  const [confirmDisableId, setConfirmDisableId] = useState<string | null>(null)
  const clientToDisable = clients.find((c) => c.clientId === confirmDisableId) ?? null

  if (clients.length === 0) return null

  const disable = (clientId: string): void => {
    mutation.mutate(
      { clientId, action: 'disable' },
      {
        onSettled: () => {
          setConfirmDisableId(null)
        },
      }
    )
  }

  const menuItemsFor = (client: Client, { action }: TrustedAppRow): readonly MenuItem[] | null => {
    if (action === null) return null
    if (mutation.isPending) {
      return [{ id: action, label: action === 'disable' ? 'Disable' : 'Enable', disabled: true }]
    }
    if (action === 'disable') {
      return [
        {
          id: 'disable',
          label: 'Disable',
          destructive: true,
          onSelect: () => {
            setConfirmDisableId(client.clientId)
          },
        },
      ]
    }
    return [
      {
        id: 'enable',
        label: 'Enable',
        onSelect: () => {
          mutation.mutate({ clientId: client.clientId, action: 'enable' })
        },
      },
    ]
  }

  return (
    <>
      <ErrorBanner error={mutation.error} />
      <ItemList
        title="Trusted Apps"
        items={clients.map((client) => {
          const row = trustedAppRow(client)
          const menuItems = menuItemsFor(client, row)
          return {
            id: client.clientId,
            title: client.name,
            subtitle: row.subtitle,
            ...(row.disabled ? { badge: 'Disabled' } : {}),
            ...(menuItems === null
              ? {}
              : { actions: <Menu label={`Actions for ${client.name}`} items={menuItems} /> }),
          }
        })}
      />
      <ConfirmDialog
        open={clientToDisable !== null}
        title="Disable App"
        confirmLabel="Disable"
        destructive
        pending={mutation.isPending}
        onConfirm={() => {
          if (clientToDisable !== null) disable(clientToDisable.clientId)
        }}
        onCancel={() => {
          setConfirmDisableId(null)
        }}
      >
        Disable &quot;{clientToDisable?.name ?? ''}&quot;? It won&apos;t be able to sign in or
        refresh its access until you enable it again.
      </ConfirmDialog>
    </>
  )
}

export { TrustedAppsList, TrustedAppsSection }
export type { TrustedAppsListProps }
