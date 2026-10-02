import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView } from 'react-tundraish'

import { appQueryOptions, useAppQuery } from '../../../queries.ts'
import { AppDetailPage } from './-app-detail-page.tsx'
import { AppEditForm } from './-forms.tsx'

/**
 * `/settings/apps/$id` — the app detail page. Reads the app (`GET /apps/:id`) and
 * renders the {@link AppDetailPage} (enable toggle + delete) around the
 * {@link AppEditForm}. An unknown id `404`s the read → the route's
 * `errorComponent`.
 */
const AppDetailScreen = ({ id }: { readonly id: string }): JSX.Element => {
  const navigate = useNavigate()
  const { data: app } = useAppQuery(id)
  return (
    <AppDetailPage
      app={{ id: app.id, name: app.name }}
      onRemoved={() => {
        void navigate({ to: '/settings/apps' })
      }}
    >
      <AppEditForm app={app} />
    </AppDetailPage>
  )
}

function AppDetailRoute(): JSX.Element {
  const { id } = Route.useParams()
  // Key on the id so a detail→detail navigation remounts the form (its controlled
  // state is seeded from the app on mount).
  return <AppDetailScreen key={id} id={id} />
}

const Route = createFileRoute('/settings/apps/$id')({
  loader: ({ context, params }) =>
    context.queryClient.query({
      ...appQueryOptions(context.runAuthed, params.id),
      staleTime: 'static',
    }),
  component: AppDetailRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Apps" />,
})

export { AppDetailScreen, Route }
