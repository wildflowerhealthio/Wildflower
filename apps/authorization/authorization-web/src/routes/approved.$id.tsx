import { createFileRoute } from '@tanstack/react-router'
import { clientsQueryOptions, grantQueryOptions } from '@wildflowerhealthio/authorization-react'
import { AsyncErrorView } from '@wildflowerhealthio/react-tundraish'
import { constVoid } from 'effect/Function'
import type { JSX } from 'react'

import { GrantDetail } from '../grant-detail.tsx'

/** The grant detail for the `$id` the path names. */
function GrantRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <GrantDetail id={id} />
}

/**
 * One grant, from either list on the access page. The trusted apps are
 * fetched but not waited on, for the client's name: until they arrive, or if
 * they fail, the detail names the client by its id alone.
 */
export const Route = createFileRoute('/approved/$id')({
  loader: ({ context, params }) => {
    context.queryClient
      .query({ ...clientsQueryOptions(context.runAuthed), staleTime: 'static' })
      .catch(constVoid)
    return context.queryClient.query({
      ...grantQueryOptions(context.runAuthed, params.id),
      staleTime: 'static',
    })
  },
  component: GrantRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Error Loading Grant" />,
})
