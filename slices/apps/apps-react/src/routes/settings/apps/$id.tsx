import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, PageHeader, ToggleSwitch } from 'react-tundraish'

import {
  appsListQueryOptions,
  useAppsAdminDeleteMutation,
  useAppsListQuery,
  useReplaceHomeScreenMutation,
  type AppEntry,
} from '../../../queries.ts'
import { provenanceLabel } from '../../_auth/home/-tiles.tsx'
import { CloudEditForm, SelfHostedLaunchPathEditor, formatError } from './-forms.tsx'
import formStyles from './-forms.module.css'

interface AppDetailBodyProps {
  readonly app: AppEntry
  /** The full registry list — the home-screen enable PUT rewrites all of it. */
  readonly apps: readonly AppEntry[]
  /** Called after a successful remove — the route navigates back to the list. */
  readonly onRemoved: () => void
}

/**
 * Per-app detail page. Carries three concerns that used to live in the apps
 * editor modal, now on their own screen:
 *
 * - **Enable/disable** (every provenance) — a `ToggleSwitch` persisted through
 *   `PUT /home-screen` (the single writer of order + `enabled`) by re-PUTting
 *   the whole list with this app's flag flipped.
 * - **Kind-specific edit** — a cloud app gets the full content form
 *   ({@link CloudEditForm}); an uploaded self-hosted app gets its launch-path
 *   editor ({@link SelfHostedLaunchPathEditor}); system + seeded apps show a
 *   read-only provenance tag (they're not editable).
 * - **Remove** — only when the row is `removable` (cloud + uploaded
 *   self-hosted); system + seeded apps show no Remove.
 *
 * Presentational + prop-driven (the app, the list, and the navigate-back
 * callback are injected) so it renders in tests without a live router.
 */
const AppDetailBody = ({ app, apps, onRemoved }: AppDetailBodyProps): JSX.Element => {
  const homeScreenMutation = useReplaceHomeScreenMutation()
  const deleteMutation = useAppsAdminDeleteMutation()

  // Enabled is homescreen-curation state: persist it by re-PUTting the whole
  // ordered list with this app's flag flipped (the single writer of `enabled`).
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
        <ToggleSwitch checked={app.enabled} label="Show on home screen" disabled />
      ) : (
        <ToggleSwitch
          checked={app.enabled}
          label="Show on home screen"
          onChange={() => {
            toggleEnabled()
          }}
        />
      )}

      <hr className={formStyles['divider']} aria-hidden="true" />

      {app.provenance === 'cloud' ? (
        <CloudEditForm app={app} />
      ) : app.provenance === 'self-hosted' && app.removable ? (
        <SelfHostedLaunchPathEditor app={app} />
      ) : (
        <p className={cn(formStyles['readonly-tag'], 'text-body-3')}>
          {provenanceLabel(app.provenance)} app — settings aren't editable.
        </p>
      )}

      {app.removable ? (
        <div className={formStyles['actions']}>
          <button
            type="button"
            className="button-2 outline accent-red"
            disabled={deleteMutation.isPending}
            onClick={remove}
          >
            Remove app
          </button>
        </div>
      ) : null}
    </>
  )
}

const AppDetailScreen = ({ id }: { readonly id: string }): JSX.Element => {
  const navigate = useNavigate()
  const { data: apps } = useAppsListQuery()
  const app = apps.find((entry) => entry.id === id)
  if (app === undefined) {
    return <AsyncErrorView error={new Error(`No app with id "${id}"`)} title="App not found" />
  }
  return (
    <AppDetailBody
      app={app}
      apps={apps}
      onRemoved={() => {
        void navigate({ to: '/settings/apps' })
      }}
    />
  )
}

/**
 * The `/settings/apps/$id` file route. Reuses the warmed apps-list cache (there
 * is no per-app read endpoint) and resolves the row from the typed `$id` param
 * (typed via the slice-local `Register` in `router.ts`). The `/settings`
 * `beforeLoad` gate guarantees a token before this loader runs, so it's a plain
 * `ensureQueryData` — failures propagate to `errorComponent`, and an unknown id
 * surfaces as the screen's "App not found".
 */
function AppDetailRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <AppDetailScreen id={id} />
}

const Route = createFileRoute('/settings/apps/$id')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(appsListQueryOptions(context.runAuthed)),
  component: AppDetailRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Apps" />,
})

export { AppDetailBody, Route }
