import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { Layer } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { routeTree } from './routeTree.gen.ts'
import { ServerKind } from './session/server-kind.ts'

/**
 * The launcher's whole route tree, as `routes.config.ts` mounts it. Access is
 * managed in the Wildflower Authorization app, which the settings screen's
 * Manage access row links out to, so no route here manages it. Structural
 * only: no loader runs, so the context fields are inert.
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
  test('has no settings/authorization route', () => {
    expect(routeIds.filter((id) => id.startsWith('/settings/authorization'))).toEqual([])
  })

  test('keeps the approval routes, which the device and OAuth flows send the Owner to', () => {
    expect(routeIds).toEqual(
      expect.arrayContaining([
        '/_open/authorization/devices',
        '/_auth/authorization/devices/$userCode',
        '/_auth/authorization/oauth-consent/$id',
      ])
    )
  })

  test('opens only device entry without a session: sign-in is the SMART one, from the landing', () => {
    expect(routeIds.filter((id) => id.startsWith('/_open/authorization/'))).toEqual([
      '/_open/authorization/devices',
    ])
  })

  test('keeps the request log in settings', () => {
    expect(routeIds).toContain('/settings/requests')
  })
})
