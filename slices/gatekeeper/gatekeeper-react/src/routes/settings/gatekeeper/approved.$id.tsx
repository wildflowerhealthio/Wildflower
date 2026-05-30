import { createFileRoute } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView, pageLayoutStyles } from 'react-tundraish'

import { grantQueryOptions, useGrantQuery } from '../../../queries/index.ts'
import { ensureAuthedQuery } from '../../../router-loader.ts'
import styles from './approved.$id.module.css'

const ApprovedAppDetailScreen = ({ id }: { readonly id: string }): JSX.Element => {
  const { data: grant } = useGrantQuery(id)
  return (
    <div className={pageLayoutStyles['page']}>
      <h1 className="text-heading-4">{grant.clientId}</h1>
      <pre className={styles['json']}>{JSON.stringify(grant, null, 2)}</pre>
    </div>
  )
}

/**
 * The `/settings/gatekeeper/approved/$id` file route. Reads the typed `$id`
 * path param from the generated route via `Route.useParams()` and hands it
 * to the screen as a prop. See {@link ensureAuthedQuery} for the loader's
 * token-ready guard and error-propagation contract.
 */
function ApprovedAppDetailRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <ApprovedAppDetailScreen id={id} />
}

export const Route = createFileRoute('/settings/gatekeeper/approved/$id')({
  loader: ({ context, params }) =>
    ensureAuthedQuery(context, grantQueryOptions(context.runAuthed, params.id)),
  component: ApprovedAppDetailRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Not Found" />,
})
