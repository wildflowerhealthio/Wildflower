import { createFileRoute, Link } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView, ItemList, PageHeader, type ItemListItem } from 'react-tundraish'

import { appsListQueryOptions, useAppsListQuery, type AppEntry } from '../../../queries.ts'
import { provenanceLabel } from '../../_auth/home/-tiles.tsx'

interface AppsListBodyProps {
  readonly apps: readonly AppEntry[]
}

/**
 * The apps settings landing — a navigation-only list of **every** registered
 * app (system / cloud / self-hosted, enabled or not), each row linking to its
 * detail page, plus an "Add app" header action. Enable/disable and edit live on
 * the per-app detail page; reordering + hiding from the home screen live on the
 * `/home` Edit mode. Presentational + prop-driven so it renders in tests without
 * the route loader.
 */
/** A catalogue row → its navigation list item (links to the detail page). */
const toItem = (app: AppEntry): ItemListItem => ({
  id: app.id,
  title: app.name,
  subtitle: app.subtitle,
  badge: provenanceLabel(app.provenance),
  meta: app.enabled ? 'On home screen' : 'Hidden',
  href: `/settings/apps/${app.id}`,
})

const AppsListBody = ({ apps }: AppsListBodyProps): JSX.Element => {
  return (
    <>
      <PageHeader
        title="Apps"
        backHref="/settings"
        backLabel="Settings"
        actions={
          <Link to="/settings/apps/new" className="button-2 filled">
            Add app
          </Link>
        }
      />
      <p className="text-body-3">
        Add, remove, and configure the apps on your home screen. Tap an app to edit its settings.
      </p>
      <ItemList items={apps.map((app) => toItem(app))} />
    </>
  )
}

const AppsListScreen = (): JSX.Element => {
  const { data: apps } = useAppsListQuery()
  return <AppsListBody apps={apps} />
}

/**
 * The `/settings/apps/` landing file route. The `/settings` `beforeLoad` gate
 * guarantees a token before this loader runs, so it's a plain `ensureQueryData`
 * — failures propagate to `errorComponent`.
 */
const Route = createFileRoute('/settings/apps/')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(appsListQueryOptions(context.runAuthed)),
  component: AppsListScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Apps" />,
})

export { AppsListBody, Route }
