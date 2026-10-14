import { QueryClient } from '@tanstack/react-query'
import { createRouter, type AnyRoute } from '@tanstack/react-router'
import { AuthorizationServerPaths } from '@wildflowerhealthio/authorization-core/page-paths'
import { Layer } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { RunAuthed } from './queries/index.ts'
import { routeTree } from './routeTree.gen.ts'

// The slice generates its own `routeTree.gen.ts`. The `_auth`/`_open`
// directories are pathless prefixes: they carry `/_auth` or `/_open` into
// each route's id (matching what the app's layouts produce) but contribute
// no URL segment, so the `fullPath`s are the slice-local URLs the macro tree
// resolves.
// Structural-only checks; no loader runs, so the context fields are inert.
const stubRunAuthed: RunAuthed = () =>
  Promise.reject(new Error('runAuthed not used in route tests'))
const router = createRouter({
  routeTree,
  context: {
    queryClient: new QueryClient(),
    runAuthed: stubRunAuthed,
    runtimeLayer: Layer.die('runtimeLayer not used in route tests'),
    awaitAuthReady: () => Promise.resolve(),
  },
})

const routes = (): readonly AnyRoute[] =>
  Object.values(router.routesById).filter((route) => route.id !== '__root__')

// Routes are bucketed by their id prefix: `_open`/`_auth` are the app's
// no-shell and authenticated mounts.
const inBucket = (prefix: string): readonly AnyRoute[] =>
  routes().filter((route) => route.id.startsWith(prefix))

const fullPaths = (bucket: readonly AnyRoute[]): readonly string[] =>
  bucket.map((route) => route.fullPath)

const open = inBucket('/_open/')
const auth = inBucket('/_auth/')

// AuthorizationServerPaths percent-encodes its params; decode so `$id` / `$userCode`
// line up with the route fullPaths TanStack resolves to.
const oauthConsent = decodeURIComponent(AuthorizationServerPaths.oauthConsentPath('$id'))
const deviceEntry = decodeURIComponent(AuthorizationServerPaths.deviceEntryPath())
const deviceConsent = decodeURIComponent(AuthorizationServerPaths.deviceConsentPath('$userCode'))

describe('AuthorizationServerPaths ↔ Route.fullPath drift', () => {
  test('every AuthorizationServerPaths redirect target has a matching route', () => {
    const external = [...fullPaths(open), ...fullPaths(auth)]
    for (const target of [oauthConsent, deviceEntry, deviceConsent]) {
      expect(external).toContain(target)
    }
  })

  // device-entry is reachable without a bearer: it is where an owner types a
  // code from another device.
  test('device-entry lives in the open bucket', () => {
    expect(fullPaths(open)).toContain(deviceEntry)
  })

  // oauth-consent and device-consent require the owner to already be
  // authenticated.
  test('oauth-consent and device-consent live in the authenticated bucket', () => {
    const authPaths = fullPaths(auth)
    expect(authPaths).toContain(oauthConsent)
    expect(authPaths).toContain(deviceConsent)
  })
})

describe('authorization route tree', () => {
  test('the generated tree exposes exactly the authorization routes', () => {
    const ids = routes()
      .map((route): string => route.id)
      .toSorted()
    expect(ids).toEqual([
      '/_auth/authorization/devices/$userCode',
      '/_auth/authorization/oauth-consent/$id',
      '/_open/authorization/devices',
    ])
  })

  test('the slice-local fullPaths resolve to the documented URLs', () => {
    const paths = fullPaths(routes()).toSorted()
    expect(paths).toEqual(
      [
        '/authorization/devices',
        '/authorization/devices/$userCode',
        '/authorization/oauth-consent/$id',
      ].toSorted()
    )
  })
})
