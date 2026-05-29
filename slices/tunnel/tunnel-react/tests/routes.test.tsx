import { QueryClient } from '@tanstack/react-query'
import { createRouter, type AnyRoute } from '@tanstack/react-router'
import { describe, expect, test } from 'vite-plus/test'

import { Layer } from 'effect'
import type { RunAuthed } from '../src/queries.ts'
import { routeTree } from '../src/routeTree.gen.ts'

// Structural-only checks; no loader runs, so the runner is unused.
const stubRunAuthed: RunAuthed = () =>
  Promise.reject(new Error('runAuthed not used in route tests'))
const router = createRouter({
  routeTree,
  context: {
    queryClient: new QueryClient(),
    runAuthed: stubRunAuthed,
    runtimeLayer: Layer.die('runtimeLayer not used in route tests'),
  },
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
