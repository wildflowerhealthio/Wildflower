import { QueryClient } from '@tanstack/react-query'
import { createRouter, type AnyRoute } from '@tanstack/react-router'
import { Layer } from 'effect'
import { GatekeeperPaths } from 'gatekeeper-core/page-paths'
import { describe, expect, test } from 'vite-plus/test'

import type { RunAuthed } from './queries/index.ts'
import { routeTree } from './routeTree.gen.ts'

// The slice generates its own `routeTree.gen.ts`. The `_auth`/`_open`
// directories are pathless prefixes: they carry `/_auth` or `/_open` into
// each route's id (matching what the app's layouts produce) but contribute
// no URL segment, so the `fullPath`s are the slice-local URLs the macro tree
// resolves. The `settings/` directory IS a real segment, so its routes carry
// `/settings` into both their id and their fullPath.
// Structural-only checks; no loader runs, so the context fields are inert.
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

// Routes are bucketed by their id prefix: `_open`/`_auth` are the app's
// no-shell and authenticated mounts; `settings` is the owner-facing mount.
const inBucket = (prefix: string): readonly AnyRoute[] =>
  routes().filter((route) => route.id.startsWith(prefix))

const fullPaths = (bucket: readonly AnyRoute[]): readonly string[] =>
  bucket.map((route) => route.fullPath)

const open = inBucket('/_open/')
const auth = inBucket('/_auth/')
const settings = inBucket('/settings/')

// GatekeeperPaths percent-encodes its params; decode so `$id` / `$userCode`
// line up with the route fullPaths TanStack resolves to.
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
  test('the generated tree exposes exactly the gatekeeper routes', () => {
    const ids = routes()
      .map((route): string => route.id)
      .toSorted()
    expect(ids).toEqual([
      '/_auth/gatekeeper/devices/$userCode',
      '/_auth/gatekeeper/oauth-consent/$id',
      '/_open/gatekeeper/devices',
      '/_open/gatekeeper/oauth-polling/$id',
      '/settings/gatekeeper/',
      '/settings/gatekeeper/approved/$id',
      '/settings/gatekeeper/requests',
      '/settings/gatekeeper/requests_/$id',
    ])
  })

  test('the slice-local fullPaths resolve to the documented URLs', () => {
    const paths = fullPaths(routes()).toSorted()
    expect(paths).toEqual(
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
