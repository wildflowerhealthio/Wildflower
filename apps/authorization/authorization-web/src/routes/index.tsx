import { createFileRoute } from '@tanstack/react-router'
import { clientsQueryOptions, grantsQueryOptions } from '@wildflowerhealthio/authorization-react'
import { constVoid } from 'effect/Function'

import { AccessPage, AccessPageError } from '../access-page.tsx'

/**
 * The access page: the server's approved apps, trusted apps and authorized
 * devices. Its loader waits only on the grants, whose failure goes to
 * {@link AccessPageError}. The trusted apps are fetched but not waited on:
 * `TrustedAppsSection` suspends on them and catches their failure itself.
 */
export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    // Not awaited, and its rejection dropped here only: the failure stays in
    // the query's state, where `TrustedAppsSection` suspends on it and shows it.
    context.queryClient
      .query({ ...clientsQueryOptions(context.runAuthed), staleTime: 'static' })
      .catch(constVoid)
    await context.queryClient.query({
      ...grantsQueryOptions(context.runAuthed),
      staleTime: 'static',
    })
  },
  component: AccessPage,
  errorComponent: ({ error, reset }) => <AccessPageError error={error} reset={reset} />,
})
