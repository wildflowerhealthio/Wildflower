import { createRootRouteWithContext, Outlet, retainSearchParams } from '@tanstack/react-router'
import { pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import { Schema } from 'effect'
import type { JSX } from 'react'

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

export const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: Schema.standardSchemaV1(ServerSearch),
  search: { middlewares: [retainSearchParams([ISS_PARAM])] },
  component: SignedInShell,
})
