import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView } from 'react-tundraish'

import { BaseAppDetailPage } from '../-base-app-detail-page.tsx'
import { SelfHostedLaunchPathEditor } from '../-forms.tsx'
import { selfHostedAppQueryOptions, useSelfHostedAppQuery } from '../../../../queries.ts'

/**
 * `/settings/apps/self-hosted/$id` — the self-hosted app detail page. Reads the
 * self-hosted detail (`GET /self-hosted-apps/:id`), and renders the shared
 * {@link BaseAppDetailPage} around either the {@link SelfHostedLaunchPathEditor}
 * (uploaded, `removable`) or a short read-only note (a seeded, protected app).
 */
const SelfHostedAppDetailScreen = ({ id }: { readonly id: string }): JSX.Element => {
  const navigate = useNavigate()
  const { data: app } = useSelfHostedAppQuery(id)
  return (
    <BaseAppDetailPage
      app={{ id: app.id, name: app.name, removable: app.isRemovable }}
      onRemoved={() => {
        void navigate({ to: '/settings/apps' })
      }}
    >
      {app.isRemovable ? (
        <SelfHostedLaunchPathEditor app={app} />
      ) : (
        <p className="text-body-3">
          {app.name} is a built-in Self-Hosted app. Its settings aren't editable.
        </p>
      )}
    </BaseAppDetailPage>
  )
}

function SelfHostedAppDetailRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <SelfHostedAppDetailScreen key={id} id={id} />
}

const Route = createFileRoute('/settings/apps/self-hosted/$id')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(selfHostedAppQueryOptions(context.runAuthed, params.id)),
  component: SelfHostedAppDetailRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Apps" />,
})

export { Route, SelfHostedAppDetailScreen }
