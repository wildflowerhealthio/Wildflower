import { QueryClient } from '@tanstack/react-query'
import { createRouter, type AnyRoute } from '@tanstack/react-router'
import { Layer } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { RunAuthed } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'

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

describe('apps route tree', () => {
  test('the generated tree exposes exactly the apps routes', () => {
    const ids = routes()
      .map((route): string => route.id)
      .toSorted()
    expect(ids).toEqual([
      '/_auth/home/',
      '/_auth/home/launch/$id',
      '/settings/apps/',
      '/settings/apps/$id',
      '/settings/apps/cloud/$id',
      '/settings/apps/new',
      '/settings/apps/self-hosted/$id',
      '/settings/apps/system/$id',
    ])
  })

  test('the slice-local fullPaths resolve to the documented URLs', () => {
    const paths = routes()
      .map((route): string => route.fullPath)
      .toSorted()
    expect(paths).toEqual([
      '/home/',
      '/home/launch/$id',
      '/settings/apps/',
      '/settings/apps/$id',
      '/settings/apps/cloud/$id',
      '/settings/apps/new',
      '/settings/apps/self-hosted/$id',
      '/settings/apps/system/$id',
    ])
  })
})
