import { createRouter, type AnyRoute } from '@tanstack/react-router'
import { describe, expect, test } from 'vite-plus/test'

import { routeTree } from '../src/routeTree.gen.ts'

// The slice generates its own `routeTree.gen.ts`. `settings/` is a real
// path segment (not a pathless bucket), so the id and the resolved
// `fullPath` both carry `/settings`. In the app the same file mounts
// under the app's `/settings` route, producing the identical id.
const router = createRouter({ routeTree })

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
