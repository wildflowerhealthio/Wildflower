import { createFileRoute, Link } from '@tanstack/react-router'
import {
  AsyncErrorView,
  ItemList,
  PageHeader,
  type ItemListItem,
} from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { appsListQueryOptions, useAppsListQuery, type AppRegistration } from '../../../queries.ts'

interface AppsListBodyProps {
  readonly apps: readonly AppRegistration[]
}

/** A catalogue row → its navigation list item (links to the detail page). */
const toItem = (app: AppRegistration): ItemListItem => ({
  id: app.id,
  title: app.name,
  subtitle: app.subtitle,
  href: `/settings/apps/${app.id}`,
})

/**
 * The apps settings landing — a navigation-only list of **every** registered
 * app (enabled or not), each row linking to its detail page, plus an "Add app"
 * header action. Enable/disable and edit live on the per-app detail page;
 * reordering + hiding from the home screen live on the `/home` Edit mode.
 * Presentational + prop-driven so it renders in tests without the route loader.
 */
const AppsListBody = ({ apps }: AppsListBodyProps): JSX.Element => {
  const onHomeScreen = apps.filter((app) => app.onHomescreen)
  const hidden = apps.filter((app) => !app.onHomescreen)
  return (
    <>
      <PageHeader
        title="Apps"
        backHref="/settings"
        backLabel="Settings"
        actions={
          <Link
            to="/settings/apps/new"
            className="button-1 ghost"
            aria-label="Add app"
            title="Add app"
            style={{
              fontWeight: 500,
              fontSize: 'var(--font-size-5)',
              color: 'var(--button-color-foreground)',
              textDecoration: 'none',
            }}
          >
            <span aria-hidden="true">＋</span>
          </Link>
        }
      />
      <p className="text-body-3">
        Add, remove, and configure the apps on your home screen. Tap an app to edit its settings.
      </p>
      {onHomeScreen.length > 0 ? (
        <ItemList title="On your home screen" items={onHomeScreen.map((app) => toItem(app))} />
      ) : null}
      {hidden.length > 0 ? (
        <ItemList title="Hidden" items={hidden.map((app) => toItem(app))} />
      ) : null}
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
    context.queryClient.query({ ...appsListQueryOptions(context.runAuthed), staleTime: 'static' }),
  component: AppsListScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Apps" />,
})

export { AppsListBody, Route }
