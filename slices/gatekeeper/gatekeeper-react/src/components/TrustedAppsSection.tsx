import { DateTime } from 'effect'
import type { JSX } from 'react'
import { useState } from 'react'
import { ErrorBanner, ItemList, Menu, type MenuItem } from 'react-tundraish'

import { useUpdateClientMutation, type Client } from '../queries/index.ts'
import { DisableClientDialog } from './DisableClientDialog.tsx'
import { trustedAppRow, type TrustedAppRow } from './trusted-app-row.ts'

interface TrustedAppsSectionProps {
  readonly clients: readonly Client[]
}

/**
 * The Owner's "Trusted Apps" list — every registered OAuth client, seeded or
 * trusted on first use — with a per-row Disable (confirmed) / Enable switch
 * that PATCHes the client's `disabledAt`. Disabling takes the Owner's trust
 * back: the app can't sign in or refresh until it's enabled again. A disable
 * scheduled for later (set through the API) shows its time and keeps no
 * Disabled badge until it arrives, and Enable cancels it. The first-party
 * host offers no switch. A failed
 * switch surfaces in the error banner; the list only changes once the server
 * confirms (no optimistic update), via the clients-list invalidation.
 */
const TrustedAppsSection = ({ clients }: TrustedAppsSectionProps): JSX.Element | null => {
  const mutation = useUpdateClientMutation()
  const [confirmDisableId, setConfirmDisableId] = useState<string | null>(null)
  const clientToDisable = clients.find((c) => c.clientId === confirmDisableId) ?? null

  if (clients.length === 0) return null

  const now = DateTime.unsafeNow()
  const rows = clients.map((client) => ({ client, row: trustedAppRow(client, now) }))

  // Disabling sends the current time: the server stamps that, or its own now
  // if the two clocks disagree and this one has already passed.
  const disable = (clientId: string): void => {
    mutation.mutate(
      { clientId, disabledAt: DateTime.unsafeNow() },
      {
        onSuccess: () => {
          setConfirmDisableId(null)
        },
      }
    )
  }

  // One switch at a time: while a disable/enable is in flight every row's
  // switch is shown disabled, so a second request can't race the first.
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
          mutation.mutate({ clientId: client.clientId, disabledAt: null })
        },
      },
    ]
  }

  return (
    <>
      <ErrorBanner error={mutation.error} />
      <ItemList
        title="Trusted Apps"
        items={rows.map(({ client, row }) => {
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
      <DisableClientDialog
        clientName={clientToDisable?.name ?? null}
        onConfirm={() => {
          if (clientToDisable !== null) disable(clientToDisable.clientId)
        }}
        onCancel={() => {
          setConfirmDisableId(null)
        }}
      />
    </>
  )
}

export { TrustedAppsSection }
export type { TrustedAppsSectionProps }
