import { createRootRoute, createRouter, type AnyRoute } from '@tanstack/react-router'
import { GatekeeperPaths } from 'gatekeeper-core/page-paths'
import { describe, expect, test } from 'vite-plus/test'

import { authRoutes, openRoutes, settingsRoutes } from '../src/route-handles.ts'

// Each factory builds a fresh route under the parent it's handed. We parent
// every bucket directly to a plain root so the resulting `fullPath`/`id` are
// the slice-local URLs (no app-side `_auth`/`_settings` layout segments), then
// run `createRouter` to populate them. The app router composes the same
// factories under its own layouts; here we only assert the slice-local shape.
const root = createRootRoute()
const open = openRoutes.map((make) => make(() => root))
const auth = authRoutes.map((make) => make(() => root))
const settings = settingsRoutes.map((make) => make(() => root))
root.addChildren([...open, ...auth, ...settings])
const router = createRouter({ routeTree: root })

const fullPaths = (routes: readonly AnyRoute[]): readonly string[] =>
  routes.map((route) => route.fullPath)

// GatekeeperPaths percent-encodes its params; decode so `$id` / `$userCode`
// line up with the route path literals TanStack resolves to.
const oauthPolling = decodeURIComponent(GatekeeperPaths.oauthPollingPath('$id'))
const oauthConsent = decodeURIComponent(GatekeeperPaths.oauthConsentPath('$id'))
const deviceEntry = decodeURIComponent(GatekeeperPaths.deviceEntryPath())
const deviceConsent = decodeURIComponent(GatekeeperPaths.deviceConsentPath('$userCode'))

describe('GatekeeperPaths ↔ Route.fullPath drift', () => {
  // One-direction drift only: owner-facing settings routes are intentionally
  // absent from `GatekeeperPaths`.
  test('every GatekeeperPaths redirect target has a matching route', () => {
    const external = [...fullPaths(open), ...fullPaths(auth)]
    for (const target of [oauthPolling, oauthConsent, deviceEntry, deviceConsent]) {
      expect(external).toContain(target)
    }
  })

  // oauth-polling and device-entry are reachable without a bearer: the
  // polling endpoint is unauth, and device-entry is where an owner types a
  // code from another device.
  test('oauth-polling and device-entry live in the open bucket', () => {
    const openPaths = fullPaths(open)
    expect(openPaths).toContain(oauthPolling)
    expect(openPaths).toContain(deviceEntry)
  })

  // oauth-consent and device-consent require the owner to already be
  // authenticated.
  test('oauth-consent and device-consent live in the authenticated bucket', () => {
    const authPaths = fullPaths(auth)
    expect(authPaths).toContain(oauthConsent)
    expect(authPaths).toContain(deviceConsent)
  })

  // GatekeeperPaths models only externally-published URLs; owner-facing
  // settings landings must never appear there.
  test('settings landings are not externally published', () => {
    const external = [...fullPaths(open), ...fullPaths(auth)]
    for (const path of fullPaths(settings)) {
      expect(external).not.toContain(path)
    }
  })
})

describe('gatekeeper settings bucket', () => {
  test('every settings route is under /settings/gatekeeper', () => {
    for (const path of fullPaths(settings)) {
      expect(path === '/settings/gatekeeper/' || path.startsWith('/settings/gatekeeper/')).toBe(
        true
      )
    }
  })

  test('declares the four owner-facing landing routes', () => {
    expect([...fullPaths(settings)].toSorted()).toEqual(
      [
        '/settings/gatekeeper/',
        '/settings/gatekeeper/approved/$id',
        '/settings/gatekeeper/requests',
        '/settings/gatekeeper/requests/$id',
      ].toSorted()
    )
  })
})

describe('gatekeeper route tree', () => {
  test('the composed tree exposes exactly the documented routes', () => {
    const ids = Object.keys(router.routesById)
      .filter((id) => id !== '__root__')
      .toSorted()
    expect(ids).toEqual(
      [
        '/gatekeeper/devices',
        '/gatekeeper/devices/$userCode',
        '/gatekeeper/oauth-consent/$id',
        '/gatekeeper/oauth-polling/$id',
        '/settings/gatekeeper/',
        '/settings/gatekeeper/approved/$id',
        '/settings/gatekeeper/requests',
        '/settings/gatekeeper/requests/$id',
      ].toSorted()
    )
  })
})
