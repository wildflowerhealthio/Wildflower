import { createRootRoute, createRouter, type AnyRoute } from '@tanstack/react-router'
import { describe, expect, test } from 'vite-plus/test'

import { authRoutes, openRoutes, settingsRoutes } from '../src/route-handles.ts'

// `route-handles.ts` exports route *factories*, not route objects: each
// builds a fresh route under an app-provided parent. We reproduce the
// slice-local URL space by parenting every factory directly to a plain
// root (the app's pathless `_auth` layout contributes no URL segment, so
// fullPaths match what the macro tree resolves). Building a router runs
// the init that populates each route's `fullPath`/`id` in place.
const root = createRootRoute()
const open = openRoutes.map((make) => make(() => root))
const auth = authRoutes.map((make) => make(() => root))
const settings = settingsRoutes.map((make) => make(() => root))
root.addChildren([...open, ...auth, ...settings])
const router = createRouter({ routeTree: root })

const fullPaths = (routes: readonly AnyRoute[]): readonly string[] =>
  routes.map((route) => route.fullPath)

describe('collector route-handles', () => {
  test('every authenticated route is under /collector', () => {
    for (const path of fullPaths(auth)) {
      expect(path.startsWith('/collector')).toBe(true)
    }
  })

  test('no authenticated route is under /settings — collector is top-level, not a settings concern', () => {
    for (const path of fullPaths(auth)) {
      expect(path.startsWith('/settings')).toBe(false)
    }
  })

  test('collector contributes only authenticated routes', () => {
    // The open and settings buckets are intentionally empty; a route landing
    // in one should be a deliberate edit, not a silent drift.
    expect(openRoutes).toEqual([])
    expect(settingsRoutes).toEqual([])
  })

  test('the factory tree exposes exactly the collector routes', () => {
    const ids = Object.keys(router.routesById)
      .filter((id) => id !== '__root__')
      .toSorted()
    expect(ids).toEqual(['/collector/', '/collector/account/$id', '/collector/account/new'])
  })
})
