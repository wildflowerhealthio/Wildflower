import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { Layer } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { routeTree } from './routeTree.gen.ts'
import { ServerKind } from './session/server-kind.ts'

/**
 * The launcher's whole route tree, as `routes.config.ts` mounts it. Access is
 * managed in the Wildflower Authorization app, which the settings screen's
 * Manage access row links out to, and requests are approved on the
 * authorization server's own consent card and device page, so no route here
 * does either. Structural only: no loader runs, so the context fields are
 * inert.
 */
const router = createRouter({
  routeTree,
  context: {
    queryClient: new QueryClient(),
    runAuthed: () => Promise.reject(new Error('runAuthed not used in route tree tests')),
    runtimeLayer: Layer.die('runtimeLayer not used in route tree tests'),
    awaitAuthReady: () => Promise.resolve(),
    serverKind: ServerKind.Wildflower(),
  },
})

const routeIds = Object.keys(router.routesById)

describe('the launcher route tree', () => {
  test('has no authorization route: access and approvals live on other surfaces', () => {
    expect(routeIds.filter((id) => id.includes('/authorization'))).toEqual([])
  })

  test('keeps the request log in settings', () => {
    expect(routeIds).toContain('/settings/requests')
  })
})
