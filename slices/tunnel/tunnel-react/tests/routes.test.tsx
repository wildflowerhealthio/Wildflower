import { createRootRoute, createRouter } from '@tanstack/react-router'
import { describe, expect, test } from 'vite-plus/test'

import { authRoutes, openRoutes, settingsRoutes } from '../src/route-handles.ts'

// Each factory builds a fresh route under the parent it's handed. We parent
// every bucket directly to a plain root so the resulting `fullPath`/`id` are
// the slice-local URLs, then run `createRouter` to populate them. The app
// router composes the same factories under its own layouts.
const root = createRootRoute()
const open = openRoutes.map((make) => make(() => root))
const auth = authRoutes.map((make) => make(() => root))
const settings = settingsRoutes.map((make) => make(() => root))
root.addChildren([...open, ...auth, ...settings])
const router = createRouter({ routeTree: root })

describe('tunnel route-handles', () => {
  test('the settings bucket declares exactly one route at /settings/tunnel/', () => {
    expect(settings.length).toBe(1)
    // The screen is an index route, so the resolved fullPath keeps the
    // trailing slash.
    expect(settings[0]?.fullPath).toBe('/settings/tunnel/')
  })

  test('tunnel contributes no open or authenticated routes', () => {
    expect(open).toEqual([])
    expect(auth).toEqual([])
  })

  test('the composed tree exposes exactly the tunnel settings route', () => {
    const ids = Object.keys(router.routesById).filter((id) => id !== '__root__')
    expect(ids).toEqual(['/settings/tunnel/'])
  })
})
