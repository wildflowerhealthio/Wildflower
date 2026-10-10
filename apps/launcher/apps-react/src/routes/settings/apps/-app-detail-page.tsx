import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBanner, PageHeader, ToggleSwitch } from '@wildflowerhealthio/react-tundraish'
import { useState, type JSX } from 'react'

import {
  useAppDeleteMutation,
  useAppReplaceMutation,
  useAppsListQuery,
  useReplaceHomeScreenMutation,
  type AppRegistration,
} from '../../../queries.ts'
import { AppFieldInputs, appBodyFrom, type AppFields } from './-forms.tsx'
import formStyles from './-forms.module.css'

/**
 * Full-replace editor for an app's content — name / subtitle / launch URL /
 * requires-tunnel, prefilled from the {@link AppRegistration}. Saving `PUT`s the
 * whole content to `/apps/:id` via {@link useAppReplaceMutation}; an empty
 * subtitle clears it.
 */
const AppEditForm = ({ app }: { readonly app: AppRegistration }): JSX.Element => {
  const replaceMutation = useAppReplaceMutation()
  const [fields, setFields] = useState<AppFields>({
    name: app.name,
    subtitle: app.subtitle ?? '',
    url: app.url,
    requiresTunnel: app.requiresTunnel,
  })

  const save = (): void => {
    const payload = appBodyFrom(fields)
    if (payload === undefined) return
    replaceMutation.mutate({ id: app.id, payload })
  }

  return (
    <form
      className={formStyles['form']}
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <ErrorBanner error={replaceMutation.error} />
      <AppFieldInputs
        fields={fields}
        disabled={replaceMutation.isPending}
        onChange={(next) => {
          if (replaceMutation.error !== null) replaceMutation.reset()
          setFields(next)
        }}
      />
      <div className={formStyles['actions']}>
        <button type="submit" className="button-3 filled" disabled={replaceMutation.isPending}>
          Save
        </button>
      </div>
    </form>
  )
}

/**
 * The app detail page: the header, an error banner, the "Show on home screen"
 * enable toggle, the {@link AppEditForm}, and the delete section.
 * The `-` prefix keeps it out of the generated route tree.
 *
 * Enable is homescreen-curation state, so the toggle re-PUTs the **whole**
 * ordered list with this app's flag flipped (the single writer of
 * `onHomescreen`); its `checked` reads the live list entry (which
 * `PUT /home-screen` invalidates), not the by-id read. Presentational +
 * prop-driven so it renders in tests without a live router.
 */
interface AppDetailPageProps {
  readonly app: AppRegistration
  /** Called after a successful remove — the route navigates back to the list. */
  readonly onRemoved: () => void
}

const AppDetailPage = ({ app, onRemoved }: AppDetailPageProps): JSX.Element => {
  const { data: apps } = useAppsListQuery()
  const homeScreenMutation = useReplaceHomeScreenMutation()
  const deleteMutation = useAppDeleteMutation()

  const enabled = apps.find((entry) => entry.id === app.id)?.onHomescreen ?? false

  // Persist the placement flag by re-PUTting the whole ordered list with this
  // app's flag flipped (the single writer of `onHomescreen`).
  const toggleEnabled = (): void => {
    homeScreenMutation.mutate(
      apps.map((entry) => ({
        id: entry.id,
        onHomescreen: entry.id === app.id ? !entry.onHomescreen : entry.onHomescreen,
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

      <ErrorBanner error={error} />

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

      <AppEditForm app={app} />

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
  )
}

export { AppDetailPage }
