import { createFileRoute, redirect } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView } from 'react-tundraish'

import { appsListQueryOptions, type AppRegistration } from '../../../queries.ts'

/**
 * The kind-agnostic `/settings/apps/$id` entry point — a **resolver**. A settings
 * list row links here without knowing the kind; the loader reads the warmed
 * apps-list cache, resolves the row's `kind`, and `redirect`s to the per-kind
 * detail route (`/settings/apps/{kind}/$id`), which owns the per-kind detail
 * query + edit form. A deep-link refresh hits the same path — the list query
 * resolves the kind first. An unknown id falls through to the "App not found"
 * screen.
 */
const KIND_ROUTE: Record<
  AppRegistration['kind'],
  '/settings/apps/cloud/$id' | '/settings/apps/self-hosted/$id' | '/settings/apps/system/$id'
> = {
  cloud: '/settings/apps/cloud/$id',
  'self-hosted': '/settings/apps/self-hosted/$id',
  system: '/settings/apps/system/$id',
}

function AppNotFoundRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <AsyncErrorView error={new Error(`No app with id "${id}"`)} title="App not found" />
}

const Route = createFileRoute('/settings/apps/$id')({
  loader: async ({ context, params }) => {
    const apps = await context.queryClient.query({
      ...appsListQueryOptions(context.runAuthed),
      staleTime: 'static',
    })
    const app = apps.find((entry) => entry.id === params.id)
    // Unknown id → render the "not found" component (no redirect).
    if (app === undefined) return
    throw redirect({ to: KIND_ROUTE[app.kind], params: { id: params.id }, replace: true })
  },
  component: AppNotFoundRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Apps" />,
})

export { Route }
