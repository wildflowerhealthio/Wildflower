import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { unknownErrorToString } from 'kitchen-sink'
import type { JSX } from 'react'
import { AsyncErrorView } from 'react-tundraish'

import { AccountFormScreen } from '../../../forms/account-form.tsx'
import {
  remoteQueryOptions,
  useRemoteQuery,
  useUpdateRemoteMutation,
} from '../../../queries/index.ts'

/**
 * The `/collector/account/$id` route. Reads the typed `$id` path param, fetches
 * the remote through `useRemoteQuery` (warmed by the route `loader`), and
 * delegates the screen to the generic {@link AccountFormScreen} — dispatched on
 * `existing.config._tag` to the registered config form and seeded from the
 * stored config. Saving rides `useUpdateRemoteMutation`, whose
 * `invalidateQueries` refetches the accounts list + this remote's detail.
 */
function AccountConfigRoute(): JSX.Element {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const { data: existing } = useRemoteQuery(id)
  const updateMutation = useUpdateRemoteMutation()
  const error = updateMutation.error === null ? null : unknownErrorToString(updateMutation.error)

  return (
    <AccountFormScreen
      title="Edit Account"
      tag={existing.config._tag}
      initial={existing.config}
      prefill={undefined}
      initialName={existing.name}
      disabled={updateMutation.isPending}
      error={error}
      onSubmit={(name, config) => {
        updateMutation.mutate(
          { id: existing.id, payload: { name, config } },
          {
            onSuccess: () => {
              void navigate({ to: '/collector' })
            },
          }
        )
      }}
      onCancel={() => {
        void navigate({ to: '/collector' })
      }}
    />
  )
}

/**
 * The `_auth` layout's `beforeLoad` gates on the bearer token, so the loader
 * can call `ensureQueryData` directly — token is guaranteed by the time it
 * runs. Genuine read failures (including a 404 `RemoteNotFound`) propagate to
 * `errorComponent`.
 */
export const Route = createFileRoute('/_auth/collector/account/$id')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(remoteQueryOptions(context.runAuthed, params.id)),
  component: AccountConfigRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Collector" />,
})
