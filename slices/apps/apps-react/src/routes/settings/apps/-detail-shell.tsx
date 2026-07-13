import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'
import { PageHeader, ToggleSwitch } from 'react-tundraish'

import {
  useAppsAdminDeleteMutation,
  useAppsListQuery,
  useReplaceHomeScreenMutation,
} from '../../../queries.ts'
import { formatError } from './-forms.tsx'
import formStyles from './-forms.module.css'

/**
 * The shared chrome every per-kind app detail page renders around its
 * kind-specific edit region (`children`): the header, an error banner, the
 * "Show on home screen" enable toggle, and — when the app is `removable` — the
 * delete section. The `-` prefix keeps it out of the generated route tree.
 *
 * Enable is homescreen-curation state, so the toggle re-PUTs the **whole**
 * ordered list with this app's flag flipped (the single writer of `enabled`);
 * its `checked` reads the live list entry (which `PUT /home-screen` invalidates),
 * not the per-kind detail. Presentational + prop-driven so it renders in tests
 * without a live router.
 */
interface AppDetailShellProps {
  readonly app: {
    readonly id: string
    readonly name: string
    readonly removable: boolean
  }
  /** Called after a successful remove — the route navigates back to the list. */
  readonly onRemoved: () => void
  /** The kind-specific edit region (a form, or a read-only note). */
  readonly children: ReactNode
}

const AppDetailShell = ({ app, onRemoved, children }: AppDetailShellProps): JSX.Element => {
  const { data: apps } = useAppsListQuery()
  const homeScreenMutation = useReplaceHomeScreenMutation()
  const deleteMutation = useAppsAdminDeleteMutation()

  const enabled = apps.find((entry) => entry.id === app.id)?.enabled ?? false

  // Persist the enable flag by re-PUTting the whole ordered list with this app's
  // flag flipped (the single writer of `enabled`).
  const toggleEnabled = (): void => {
    homeScreenMutation.mutate(
      apps.map((entry) => ({
        id: entry.id,
        enabled: entry.id === app.id ? !entry.enabled : entry.enabled,
      }))
    )
  }

  const remove = (): void => {
    deleteMutation.mutate({ id: app.id }, { onSuccess: onRemoved })
  }

  const error = homeScreenMutation.error ?? deleteMutation.error

  return (
    <>
      <PageHeader title={app.name} backHref="/settings/apps" backLabel="Apps" />

      {error !== null ? (
        <p className={cn(formStyles['error'], 'text-body-3')} role="alert">
          {formatError(error)}
        </p>
      ) : null}

      {homeScreenMutation.isPending ? (
        <ToggleSwitch checked={enabled} label="Show on home screen" disabled />
      ) : (
        <ToggleSwitch
          checked={enabled}
          label="Show on home screen"
          onChange={() => {
            toggleEnabled()
          }}
        />
      )}

      <hr className={formStyles['divider']} aria-hidden="true" />

      {children}

      {app.removable ? (
        <>
          <hr className={formStyles['divider']} aria-hidden="true" />
          <p className={cn(formStyles['delete-note'], 'text-body-3')}>
            Deletes this app from this device. It doesn't necessarily erase data the app has already
            stored elsewhere.
          </p>
          <div className={formStyles['actions']}>
            <button
              type="button"
              className="button-3 outline accent-red"
              style={{ width: '100%' }}
              disabled={deleteMutation.isPending}
              onClick={remove}
            >
              Delete from my device
            </button>
          </div>
        </>
      ) : null}
    </>
  )
}

export { AppDetailShell }
