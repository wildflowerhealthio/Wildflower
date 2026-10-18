import { createFileRoute } from '@tanstack/react-router'
import {
  browserSessionsQueryOptions,
  clientsQueryOptions,
  grantsQueryOptions,
} from '@wildflowerhealthio/authorization-react'
import { constVoid } from 'effect/Function'

import { AccessPage, AccessPageError } from '../access-page.tsx'

/**
 * The access page: the server's approved apps, trusted apps, authorized
 * devices and signed-in browsers. Its loader waits only on the grants, whose
 * failure goes to {@link AccessPageError}. The trusted apps and the browsers
 * are fetched but not waited on: `TrustedAppsSection` and `BrowsersSection`
 * suspend on them and catch their failure themselves. The browsers are read
 * afresh on every visit, since browsers sign in and are used outside this
 * app; that one read is all the section makes.
 */
export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    // Not awaited, and their rejections dropped here only: each failure stays
    // in its query's state, where `TrustedAppsSection` or `BrowsersSection`
    // suspends on it and shows it.
    context.queryClient
      .query({ ...clientsQueryOptions(context.runAuthed), staleTime: 'static' })
      .catch(constVoid)
    context.queryClient
      .query({ ...browserSessionsQueryOptions(context.runAuthed), staleTime: 0 })
      .catch(constVoid)
    await context.queryClient.query({
      ...grantsQueryOptions(context.runAuthed),
      staleTime: 'static',
    })
  },
  component: AccessPage,
  errorComponent: ({ error, reset }) => <AccessPageError error={error} reset={reset} />,
})
