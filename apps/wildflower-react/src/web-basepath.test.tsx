import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { basenameOf } from 'branding-core'
import { describe, expect, test } from 'vite-plus/test'

/**
 * The hosted `main-web` build is path-independent (`base: './'`) and is
 * published under a subpath — `/app/` for the live copy, `/staging/pr-<n>/app/`
 * for a PR preview. `main-web.tsx` passes that served directory to
 * `createRouter` as its `basepath` (via `basenameOf(location.pathname)`); these
 * pin the two halves of the contract that keeps the app off its own not-found
 * there:
 *
 *   - a URL under the subpath resolves to the app's root-absolute route, and
 *   - a link the app builds carries the subpath back into the address bar, so
 *     the GitHub Pages 404 → redirect round-trip returns to the same place.
 *
 * The `basepath` string here is exactly what `basenameOf` yields for a boot
 * landing on the app root — trailing slash included — so the test also guards
 * that the router accepts that shape unchanged (its `basepath` normalisation
 * trims the slash internally).
 */
describe('main-web router basepath', () => {
  const previewDir = '/staging/pr-719/app/'
  // The value `main-web.tsx` computes at boot, for both a direct load of the
  // preview root and its `index.html`.
  const basepath = basenameOf(`${previewDir}index.html`)

  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/home',
    component: () => null,
  })
  const routeTree = rootRoute.addChildren([indexRoute, homeRoute])

  const routerAt = (url: string): AnyRouter =>
    createRouter({
      routeTree,
      basepath,
      history: createMemoryHistory({ initialEntries: [url] }),
    })

  test('basepath is the served directory, slash included', () => {
    expect(basepath).toBe(previewDir)
  })

  test('the subpath root resolves the index route, not a not-found', async () => {
    const router = routerAt(previewDir)
    await router.load()

    expect(router.state.matches.map((match) => match.routeId)).toContain(indexRoute.id)
    expect(router.state.matches.some((match) => match.status === 'notFound')).toBe(false)
  })

  test('a deep route under the subpath resolves its route', async () => {
    // The address a 404 redirect restores before the router mounts (see
    // `restoreRedirectedUrl`): `/staging/pr-719/app/` + the carried `/home`.
    const router = routerAt(`${previewDir}home`)
    await router.load()

    expect(router.state.matches.map((match) => match.routeId)).toContain(homeRoute.id)
    expect(router.state.matches.some((match) => match.status === 'notFound')).toBe(false)
  })

  test('a built link carries the subpath back into the address bar', () => {
    const router = routerAt(previewDir)

    // Root-absolute in the route tree, subpath-absolute in the URL — so a reload
    // of it 404s to the right app root and redirects home again.
    expect(router.buildLocation({ to: '/home' }).href).toBe(`${previewDir}home`)
  })
})
