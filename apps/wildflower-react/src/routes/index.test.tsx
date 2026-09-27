import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as fc from 'fast-check'
import { serverUrlFromSearch } from 'gatekeeper-core/smart-client'
import { makeBearerAuthStateStore, type BearerAuthStateStore } from 'gatekeeper-react'
import { numRunsFor } from 'kitchen-sink/test'
import { AuthedUntil, AuthStateProvider } from 'react-kitchen-sink'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import type { SignInStep } from '../sign-in.ts'
import { DEFAULT_SERVER_URL, rememberSignedInServer } from '../web-entry.ts'
import { Landing, shouldSignInOnArrival, type LandingSignIn } from './index.tsx'

/**
 * The landing page is the whole entry point for `main-web` — the only screen an
 * unauthed reader can reach, and the one that starts the SMART redirect. These
 * pin what it offers before and after a server is chosen, and that an
 * already-signed-in reader is sent on rather than left sitting here.
 *
 * The component reads `window.location.search` directly (that is where
 * `?server=` lives on a real load), so each test points jsdom at the URL under
 * test rather than passing one in.
 */
describe('Landing', () => {
  afterEach(() => {
    cleanup()
    window.sessionStorage.clear()
  })

  test('offers the server picker but no sign-in until a server is chosen', async () => {
    // Arrange
    const signIn = recordingSignIn(pendingStart)

    // Act — a bare visit, before any server has been picked.
    await mountLanding('/', { signIn: signIn.stub })

    // Assert — signing in needs a target, so nothing starts and the call to
    // action is absent.
    await waitFor(() => {
      expect(localServerButton()).toBeDefined()
    })
    expect(screen.queryByRole('button', { name: /sign in/i })).toBeNull()
    expect(signIn.started).toEqual([])
  })

  test('signs in straight away to the server named by ?server=', async () => {
    // Arrange — a server's own link into the app, or the auth gate's bounce:
    // the reader has nothing to pick, so a button would only be a dead step.
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Ok', value: 'http://127.0.0.1:8080/oauth/authorize?x=1' })
    )

    // Act
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', { signIn: signIn.stub })

    // Assert — the sign-in targets the named server and leaves for its
    // authorization URL.
    await waitFor(() => {
      expect(signIn.left).toEqual(['http://127.0.0.1:8080/oauth/authorize?x=1'])
    })
    expect(signIn.started).toEqual(['http://127.0.0.1:8080'])
  })

  test('signs in straight away to the server this tab last signed in to', async () => {
    // Arrange — a reload, or the expiry bounce: the settled URL names no server,
    // but the tab remembered the one its last sign-in was redeemed against.
    rememberSignedInServer(window.sessionStorage, 'https://ruth.wildflowerhealth.io')
    const signIn = recordingSignIn(pendingStart)

    // Act
    await mountLanding('/', { signIn: signIn.stub })

    // Assert
    await waitFor(() => {
      expect(signIn.started).toEqual(['https://ruth.wildflowerhealth.io'])
    })
  })

  test('shows why an automatic sign-in failed and does not retry it', async () => {
    // Arrange — the server named by ?server= can't be reached.
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Failed', reason: 'Could not reach the server.' })
    )

    // Act
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', { signIn: signIn.stub })

    // Assert — the reason shows, the manual control is back, and the page does
    // not loop trying again.
    await waitFor(() => {
      expect(screen.getByText(/Could not reach the server\./)).toBeDefined()
    })
    expect(
      screen.getByRole('button', { name: /sign in to http:\/\/127\.0\.0\.1:8080/i })
    ).toBeDefined()
    expect(signIn.started).toHaveLength(1)
  })

  test('does not sign in on arrival after a sign-in just failed', async () => {
    // Arrange — the previous attempt came back failed; starting another on
    // arrival would bounce the reader straight back to the same failure.
    const signIn = recordingSignIn(pendingStart)

    // Act
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', {
      signIn: signIn.stub,
      bootSignInProblem: 'The authorization request was denied.',
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByText(/was denied/)).toBeDefined()
    })
    expect(signIn.started).toEqual([])
  })

  test('shows a sign-in that failed before the tree existed', async () => {
    // Arrange / Act — the boot-time redemption failed, so `main-web` threaded
    // the reason in rather than leaving the reader with a silent bounce.
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', {
      bootSignInProblem: 'The token request was rejected: invalid_grant.',
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByText(/invalid_grant/)).toBeDefined()
    })
  })

  test('does not name the Local Network Access prompt from a plain-http page', async () => {
    // Arrange / Act — a loopback failure on a page served over plain http (the
    // default jsdom origin). That page is not making the public→local jump
    // Chrome guards, so the reason shows but the prompt hint does not — this
    // pins that the surface passes the page's own security through, rather than
    // hard-coding it. The secure-page positive is covered by
    // `local-network-hint.test.ts`.
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', {
      bootSignInProblem: 'Could not reach the server.',
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByText(/Could not reach the server\./)).toBeDefined()
    })
    expect(screen.queryByText(/Local Network Access/)).toBeNull()
  })

  test('sends an already-signed-in reader on to the app', async () => {
    // Arrange — authed before the router mounts, which is what `main-web`'s
    // boot does after it redeems a callback.
    const store = makeBearerAuthStateStore()
    store.writeBearer('tok_web')
    store.setAuthState(AuthedUntil({ exp: Math.floor(Date.now() / 1000) + 3600 }))

    // Act
    const router = await mountLanding('/', { store })

    // Assert — the bounce runs in an effect, so it lands after a tick. Done in
    // the render body it could be dropped, leaving a signed-in reader parked on
    // the picker.
    await waitFor(() => {
      expect(router.pathname()).toBe('/home')
    })
  })

  test('keeps the served subpath when a server is chosen', async () => {
    // Arrange — the hosted build is served under a subpath, not the origin root.
    const appBase = '/staging/pr-719/app/'
    await mountLanding(appBase, { basepath: appBase, signIn: recordingSignIn(pendingStart).stub })

    // Act — picking the local server records `?server=` in the address bar. The
    // record is written synchronously, before the sign-in redirect leaves.
    await waitFor(() => {
      expect(localServerButton()).toBeDefined()
    })
    fireEvent.click(localServerButton())

    // Assert — the reader stays on the app's own subpath (not moved to `/`), and
    // `?server=` is now set there. A root path would point the parameter at a
    // page that is not this app.
    expect(window.location.pathname).toBe(appBase)
    expect(serverUrlFromSearch(window.location.search)).toBe(DEFAULT_SERVER_URL)
  })

  test('signs in to a hosted subdomain’s origin, as a Wildflower server', async () => {
    // Arrange
    const signIn = recordingSignIn(pendingStart)
    await mountLanding('/', { signIn: signIn.stub })
    const hosted = within(await screen.findByRole('form', { name: HOSTED_GROUP_NAME }))

    // Act
    fireEvent.change(hosted.getByLabelText('Subdomain of wildflowerhealth.io'), {
      target: { value: 'ruth' },
    })
    fireEvent.click(hosted.getByRole('button', { name: 'Connect' }))

    // Assert — the Wildflower server's own FHIR base is `beginSignIn`'s
    // default, so none is passed.
    await waitFor(() => {
      expect(signIn.started).toEqual(['https://ruth.wildflowerhealth.io'])
    })
    expect(signIn.fhirBaseUrls).toEqual([undefined])
    expect(serverUrlFromSearch(window.location.search)).toBe('https://ruth.wildflowerhealth.io')
  })

  test('signs in to the demo server at its FHIR base, under its notice', async () => {
    // Arrange — the SmartHealthIT demo is a plain SMART server: it has no
    // `/fhir-r4` of its own, so its preset is its FHIR base.
    const signIn = recordingSignIn(pendingStart)
    await mountLanding('/', { signIn: signIn.stub })
    const demo = within(await screen.findByRole('region', { name: DEMO_GROUP_NAME }))

    // Act
    fireEvent.click(demo.getByRole('button', { name: 'Launch as logged in patient' }))

    // Assert — the reader is told what won't work there, and the sign-in
    // discovers at the picked URL, which `?server=` then names.
    expect(demo.getByText(/Wildflower specific features won't be available/)).toBeDefined()
    await waitFor(() => {
      expect(signIn.started).toHaveLength(1)
    })
    const [demoFhirBase] = signIn.started
    expect(demoFhirBase).toMatch(/^https:\/\/launch\.smarthealthit\.org\/.*\/fhir$/)
    expect(signIn.fhirBaseUrls).toEqual([demoFhirBase])
    expect(serverUrlFromSearch(window.location.search)).toBe(demoFhirBase)
  })

  test('shows why a pick failed once, in the menu, with the menu ready for a retry', async () => {
    // Arrange
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Failed', reason: 'Could not reach the server.' })
    )
    await mountLanding('/', { signIn: signIn.stub })
    await waitFor(() => {
      expect(localServerButton()).toBeDefined()
    })

    // Act
    fireEvent.click(localServerButton())

    // Assert — one banner, not the menu's and the page's both.
    await waitFor(() => {
      expect(screen.getAllByText(/Could not reach the server\./)).toHaveLength(1)
    })
    expect(localServerButton().hasAttribute('disabled')).toBe(false)
  })

  test('moves a failure to the page’s banner when the page’s own sign-in retries a pick', async () => {
    // Arrange — a pick that failed, reported by the menu; the picked server is
    // now the page's, with its "Sign in to …" button.
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Failed', reason: 'Could not reach the server.' })
    )
    await mountLanding('/', { signIn: signIn.stub })
    await waitFor(() => {
      expect(localServerButton()).toBeDefined()
    })
    fireEvent.click(localServerButton())
    const retry = await screen.findByRole('button', {
      name: /sign in to http:\/\/127\.0\.0\.1:8080/i,
    })
    await waitFor(() => {
      expect(retry.hasAttribute('disabled')).toBe(false)
    })

    // Act
    fireEvent.click(retry)

    // Assert — the retry's failure shows, and the menu's report of the earlier
    // pick is gone rather than repeated beside it.
    await waitFor(() => {
      expect(signIn.started).toHaveLength(2)
    })
    await waitFor(() => {
      expect(screen.getAllByText(/Could not reach the server\./)).toHaveLength(1)
    })
  })

  test('keeps the menu disabled while the sign-in on arrival is in flight', async () => {
    // Arrange / Act — a named server, whose sign-in never settles.
    const signIn = recordingSignIn(pendingStart)
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', { signIn: signIn.stub })

    // Assert — a pick now would start a second flow over the first.
    await waitFor(() => {
      expect(signIn.started).toEqual(['http://127.0.0.1:8080'])
    })
    expect(localServerButton().hasAttribute('disabled')).toBe(true)
  })
})

describe('shouldSignInOnArrival', () => {
  test('should sign in when a usable, reachable server is named and nothing just failed', () => {
    expect(
      shouldSignInOnArrival({
        hasChosenServer: true,
        blockedReason: undefined,
        bootSignInProblem: undefined,
      })
    ).toBe(true)
  })

  test('should never sign in on arrival while anything stands in the way', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (hasChosenServer, blockedReason, bootSignInProblem) => {
          // Arrange — at least one of: no server chosen, the server is
          // unreachable from this page, or a sign-in just failed.
          fc.pre(!hasChosenServer || blockedReason !== undefined || bootSignInProblem !== undefined)

          // Act
          const decision = shouldSignInOnArrival({
            hasChosenServer,
            blockedReason,
            bootSignInProblem,
          })

          // Assert
          expect(decision).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/**
 * Mount the landing page at `url` under a minimal router carrying a `/home`
 * stub for the bounce to land on. jsdom's address is set to the same `url`,
 * since the component reads `window.location.search` for `?server=`.
 */
const mountLanding = async (
  url: string,
  options: {
    readonly store?: BearerAuthStateStore
    readonly bootSignInProblem?: string
    /**
     * Router basepath, when `url` is under a subpath rather than the origin
     * root — mirrors what `main-web` passes so `/` still resolves the landing
     * there. See `web-basepath.test.tsx`.
     */
    readonly basepath?: string
    /** The sign-in stand-in; a never-settling one by default, so no test reaches the network. */
    readonly signIn?: LandingSignIn
  } = {}
): Promise<{ readonly pathname: () => string }> => {
  window.history.replaceState(null, '', url)

  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <Landing
        bootSignInProblem={options.bootSignInProblem}
        signIn={options.signIn ?? recordingSignIn(pendingStart).stub}
      />
    ),
  })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/home',
    component: () => <p>home</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, homeRoute]),
    basepath: options.basepath,
    history: createMemoryHistory({ initialEntries: [url] }),
  })

  render(
    <AuthStateProvider store={options.store ?? makeBearerAuthStateStore()}>
      <RouterProvider router={router} />
    </AuthStateProvider>
  )
  await waitFor(() => {
    expect(router.state.status).toBe('idle')
  })
  return { pathname: () => router.state.location.pathname }
}

/** The menu's group names this page is driven through (`smart-app-react`'s presets). */
const LOCAL_GROUP_NAME = 'Local Wildflower Server'
const HOSTED_GROUP_NAME = 'Wildflower Health hosted server'
const DEMO_GROUP_NAME = 'Smart Health IT Demo Server'

/** The menu's one-click sign-in to the local Wildflower server. */
const localServerButton = (): HTMLElement =>
  within(screen.getByRole('region', { name: LOCAL_GROUP_NAME })).getByRole('button', {
    name: 'Connect',
  })

/** A sign-in start that never settles — the page stays "taking you to sign in". */
const pendingStart = (): Promise<SignInStep<string>> => new Promise(() => {})

/**
 * A {@link LandingSignIn} stand-in that records each target, the FHIR base each
 * was started with (`undefined` for a Wildflower server's own), and each
 * departure.
 */
const recordingSignIn = (
  start: (target: string) => Promise<SignInStep<string>>
): {
  readonly stub: LandingSignIn
  readonly started: string[]
  readonly fhirBaseUrls: (string | undefined)[]
  readonly left: string[]
} => {
  const started: string[] = []
  const fhirBaseUrls: (string | undefined)[] = []
  const left: string[] = []
  return {
    started,
    fhirBaseUrls,
    left,
    stub: {
      start: (target, fhirBaseUrl) => {
        started.push(target)
        fhirBaseUrls.push(fhirBaseUrl)
        return start(target)
      },
      leave: (authorizationUrl) => {
        left.push(authorizationUrl)
      },
    },
  }
}
