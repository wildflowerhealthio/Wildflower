import { createFileRoute } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView } from 'react-tundraish'

import { grantQueryOptions, useGrantQuery } from '../../../queries/index.ts'
import styles from './approved.$id.module.css'

const ApprovedAppDetailScreen = ({ id }: { readonly id: string }): JSX.Element => {
  const { data: grant } = useGrantQuery(id)
  return (
    <>
      <h1 className="text-heading-4">{grant.clientId}</h1>
      <pre className={styles['json']}>{JSON.stringify(grant, null, 2)}</pre>
    </>
  )
}

/**
 * The `/settings/gatekeeper/approved/$id` file route. Reads the typed `$id`
 * path param from the generated route via `Route.useParams()` and hands it
 * to the screen as a prop. The `_auth` / `/settings` `beforeLoad` gate
 * guarantees a token before this loader runs, so it's a plain
 * `ensureQueryData` — failures propagate to the route's `errorComponent`.
 */
function ApprovedAppDetailRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <ApprovedAppDetailScreen id={id} />
}

export const Route = createFileRoute('/settings/gatekeeper/approved/$id')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(grantQueryOptions(context.runAuthed, params.id)),
  component: ApprovedAppDetailRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Not Found" />,
})
