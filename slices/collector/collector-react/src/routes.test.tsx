import { QueryClient } from '@tanstack/react-query'
import { createRouter, type AnyRoute } from '@tanstack/react-router'
import { Layer } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { RunAuthed } from './queries/index.ts'
import { routeTree } from './routeTree.gen.ts'

// The slice generates its own `routeTree.gen.ts`. The `_auth/` directory
// is a pathless prefix: it carries `/_auth` into each route's id (so the
// id matches what the app's `_auth` layout produces) but contributes no
// URL segment, so the `fullPath`s below are the slice-local URLs the
// macro tree resolves.
//
// The `__root` is `createRootRouteWithContext<RouterContext>()`, so
// `createRouter` requires a `context`. These are structural-only checks —
// no loader runs — so the context fields are inert stubs.
const stubRunAuthed: RunAuthed = () =>
  Promise.reject(new Error('runAuthed not used in route tests'))
const router = createRouter({
  routeTree,
  context: {
    queryClient: new QueryClient(),
    runAuthed: stubRunAuthed,
    runtimeLayer: Layer.die('runtimeLayer not used in route tests'),
    isTokenReady: () => false,
  },
})

const routes = (): readonly AnyRoute[] =>
  Object.values(router.routesById).filter((route) => route.id !== '__root__')

describe('collector routes', () => {
  test('every collector route resolves under /collector', () => {
    for (const route of routes()) {
      expect(route.fullPath.startsWith('/collector')).toBe(true)
    }
  })

  test('no collector route resolves under /settings — collector is top-level, not a settings concern', () => {
    for (const route of routes()) {
      expect(route.fullPath.startsWith('/settings')).toBe(false)
    }
  })

  test('the generated tree exposes exactly the collector routes', () => {
    const ids = routes()
      .map((route): string => route.id)
      .toSorted()
    expect(ids).toEqual([
      '/_auth/collector',
      '/_auth/collector/',
      '/_auth/collector/account/$id',
      '/_auth/collector/account/new',
    ])
  })

  test('the collector layout route is the parent of every collector page', () => {
    // `/_auth/collector` is the shared layout route: it renders the page
    // shell around an `<Outlet />`, and the index, new-account, and
    // edit-account pages all hang off it. Asserting the parent id keeps the
    // single-wrapper guarantee from silently regressing back to per-page
    // wrappers.
    const pageIds = [
      '/_auth/collector/',
      '/_auth/collector/account/$id',
      '/_auth/collector/account/new',
    ] as const
    for (const id of pageIds) {
      expect(router.routesById[id]?.parentRoute?.id).toBe('/_auth/collector')
    }
  })
})
