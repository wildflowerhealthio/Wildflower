import { createRouter, type AnyRoute } from '@tanstack/react-router'
import { describe, expect, test } from 'vite-plus/test'

import { routeTree } from '../src/routeTree.gen.ts'

// The slice generates its own `routeTree.gen.ts`. The `_auth/` directory is
// a pathless prefix: it carries `/_auth` into each route's id (so the id
// matches what the app's `_auth` layout produces) but contributes no URL
// segment, so the `fullPath`s below are the slice-local URLs the macro tree
// resolves.
const router = createRouter({ routeTree })

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
