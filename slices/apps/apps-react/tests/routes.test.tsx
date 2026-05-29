import { QueryClient } from '@tanstack/react-query'
import { createRouter, type AnyRoute } from '@tanstack/react-router'
import type { RunAuthed } from 'tunnel-react'
import { describe, expect, test } from 'vite-plus/test'

import { routeTree } from '../src/routeTree.gen.ts'

// The slice's root is now typed with `AppsRouterContext`
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

describe('apps route tree', () => {
  test('the generated tree exposes exactly the apps routes', () => {
    const ids = routes()
      .map((route): string => route.id)
      .toSorted()
    expect(ids).toEqual(['/_auth/apps/'])
  })

  test('the slice-local fullPaths resolve to the documented URLs', () => {
    const paths = routes()
      .map((route): string => route.fullPath)
      .toSorted()
    expect(paths).toEqual(['/apps/'])
  })
})
