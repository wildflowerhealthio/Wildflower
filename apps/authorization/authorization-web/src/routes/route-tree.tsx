import {
  createRootRouteWithContext,
  createRoute,
  Outlet,
  retainSearchParams,
} from '@tanstack/react-router'
import {
  clientsQueryOptions,
  grantQueryOptions,
  grantsQueryOptions,
} from '@wildflowerhealthio/authorization-react'
import { AsyncErrorView, pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import { Schema } from 'effect'
import { constVoid } from 'effect/Function'
import type { JSX } from 'react'

import { AccessPage, AccessPageError } from '../access-page.tsx'
import { GrantDetail } from '../grant-detail.tsx'
import type { RouterContext } from '../router-context.ts'
import { ISS_PARAM } from '../server-param.ts'

/**
 * The search every route carries: the server the page manages, `?iss=`. The
 * root keeps it on every navigation, so a reload or a bookmark of any page
 * signs back in to the same server.
 */
const ServerSearch = Schema.Struct({ [ISS_PARAM]: Schema.optional(Schema.String) })

/** The signed-in pages, in the shared page shell. */
function SignedInShell(): JSX.Element {
  return (
    <div className={pageLayoutStyles['page']}>
      <Outlet />
    </div>
  )
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  validateSearch: Schema.standardSchemaV1(ServerSearch),
  search: { middlewares: [retainSearchParams([ISS_PARAM])] },
  component: SignedInShell,
})

/**
 * The access route's loader. It waits only on the grants, whose failure goes
 * to {@link AccessPageError}. The trusted apps are fetched but not waited on:
 * `TrustedAppsSection` suspends on them and catches their failure itself.
 */
const loadAccessPage = async ({ context }: { readonly context: RouterContext }): Promise<void> => {
  // Not awaited, and its rejection dropped here only: the failure stays in
  // the query's state, where `TrustedAppsSection` suspends on it and shows it.
  context.queryClient
    .query({ ...clientsQueryOptions(context.runAuthed), staleTime: 'static' })
    .catch(constVoid)
  await context.queryClient.query({ ...grantsQueryOptions(context.runAuthed), staleTime: 'static' })
}

/** The access page: the server's approved apps, trusted apps and authorized devices. */
const accessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: loadAccessPage,
  component: AccessPage,
  errorComponent: ({ error, reset }) => <AccessPageError error={error} reset={reset} />,
})

/** One grant, from either list on the access page. */
const grantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/approved/$id',
  loader: ({ context, params }) =>
    context.queryClient.query({
      ...grantQueryOptions(context.runAuthed, params.id),
      staleTime: 'static',
    }),
  component: GrantRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Not Found" />,
})

/** The grant detail for the `$id` the path names. */
function GrantRoute(): JSX.Element {
  const { id } = grantRoute.useParams()
  return <GrantDetail id={id} />
}

/** The signed-in app's routes: the access page and a grant's detail. */
const routeTree = rootRoute.addChildren([accessRoute, grantRoute])

export { routeTree }
