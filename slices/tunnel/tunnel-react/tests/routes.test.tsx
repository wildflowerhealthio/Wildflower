import { QueryClient } from '@tanstack/react-query'
import { createRouter, type AnyRoute } from '@tanstack/react-router'
import { describe, expect, test } from 'vite-plus/test'

import type { RunAuthed } from '../src/queries.ts'
import { routeTree } from '../src/routeTree.gen.ts'

// The slice's root is now typed with `TunnelRouterContext`
// (`createRootRouteWithContext`), so the router needs a context value.
// These tests only inspect the generated tree's structure (ids /
// fullPaths) — no loader runs — so a stub context that never resolves an
// effect suffices.
const stubRunAuthed: RunAuthed = () =>
  Promise.reject(new Error('runAuthed not used in route tests'))
const router = createRouter({
  routeTree,
  context: { queryClient: new QueryClient(), runAuthed: stubRunAuthed },
})

const routes = (): readonly AnyRoute[] =>
  Object.values(router.routesById).filter((route) => route.id !== '__root__')

describe('tunnel routes', () => {
  test('the generated tree exposes exactly the tunnel settings route', () => {
    const ids = routes().map((route) => route.id)
    expect(ids).toEqual(['/settings/tunnel/'])
  })

  test('the settings route resolves at /settings/tunnel/', () => {
    // The screen is an index route, so the resolved fullPath keeps the
    // trailing slash.
    expect(routes()[0]?.fullPath).toBe('/settings/tunnel/')
  })
})
