import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView } from 'react-tundraish'

import { AppDetailShell } from '../-detail-shell.tsx'
import { CloudEditForm } from '../-forms.tsx'
import { cloudAppQueryOptions, useCloudAppQuery } from '../../../../queries.ts'

/**
 * `/settings/apps/cloud/$id` — the cloud app detail page. Reads the cloud detail
 * (`GET /cloud-apps/:id`), renders the shared {@link AppDetailShell} (enable
 * toggle + delete) around the {@link CloudEditForm}. A non-cloud id `404`s the
 * detail read → the route's `errorComponent`.
 */
const CloudAppDetailScreen = ({ id }: { readonly id: string }): JSX.Element => {
  const navigate = useNavigate()
  const { data: app } = useCloudAppQuery(id)
  return (
    <AppDetailShell
      app={{ id: app.id, name: app.name, removable: app.removable }}
      onRemoved={() => {
        void navigate({ to: '/settings/apps' })
      }}
    >
      <CloudEditForm app={app} />
    </AppDetailShell>
  )
}

function CloudAppDetailRoute(): JSX.Element {
  const { id } = Route.useParams()
  // Key on the id so a detail→detail navigation remounts the form (its controlled
  // state is seeded from the detail on mount).
  return <CloudAppDetailScreen key={id} id={id} />
}

const Route = createFileRoute('/settings/apps/cloud/$id')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(cloudAppQueryOptions(context.runAuthed, params.id)),
  component: CloudAppDetailRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Apps" />,
})

export { CloudAppDetailScreen, Route }
