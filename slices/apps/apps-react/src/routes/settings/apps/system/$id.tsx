import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView } from 'react-tundraish'

import { AppDetailShell } from '../-detail-shell.tsx'
import { systemAppQueryOptions, useSystemAppQuery } from '../../../../queries.ts'

/**
 * `/settings/apps/system/$id` — the read-only system app detail page. Reads the
 * system detail (`GET /system-apps/:id`) and renders the shared
 * {@link AppDetailShell} (a system app is never removable, so no delete) around a
 * short read-only note.
 */
const SystemAppDetailScreen = ({ id }: { readonly id: string }): JSX.Element => {
  const navigate = useNavigate()
  const { data: app } = useSystemAppQuery(id)
  return (
    <AppDetailShell
      app={{ id: app.id, name: app.name, removable: false }}
      onRemoved={() => {
        void navigate({ to: '/settings/apps' })
      }}
    >
      <p className="text-body-3">
        {app.name} is a System app built into Wildflower. Its settings aren't editable.
      </p>
    </AppDetailShell>
  )
}

function SystemAppDetailRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <SystemAppDetailScreen key={id} id={id} />
}

const Route = createFileRoute('/settings/apps/system/$id')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(systemAppQueryOptions(context.runAuthed, params.id)),
  component: SystemAppDetailRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Apps" />,
})

export { Route, SystemAppDetailScreen }
