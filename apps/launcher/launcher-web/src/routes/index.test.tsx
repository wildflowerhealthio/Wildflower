import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { serverUrlFromSearch } from '@wildflowerhealthio/authorization-core/smart-client'
import {
  makeBearerAuthStateStore,
  type BearerAuthStateStore,
} from '@wildflowerhealthio/authorization-react'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { AuthedUntil, AuthStateProvider } from '@wildflowerhealthio/react-kitchen-sink'
import type * as TelemetryWeb from '@wildflowerhealthio/telemetry-web'
import * as fc from 'fast-check'
import { StrictMode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import {
  signInEnvironment,
  startSignIn,
  unsentEhrLaunch,
  type SignInProblem,
  type SignInStep,
  type UnsentEhrLaunch,
} from '../sign-in.ts'
import { SIGNED_IN_SERVER_KEY } from '../web-entry.ts'
import { Landing, shouldSignInOnArrival, type LandingSignIn } from './index.tsx'

// Which server hosts the landing redacts from telemetry; the rest of the
// module stays real.
const { redactServerHostMock } = vi.hoisted(() => ({
  redactServerHostMock: vi.fn<typeof TelemetryWeb.redactServerHost>(),
}))
vi.mock('@wildflowerhealthio/telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  redactServerHost: redactServerHostMock,
}))

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
    vi.unstubAllGlobals()
    redactServerHostMock.mockClear()
  })

  test('offers the server picker but no sign-in until a server is chosen', async () => {
    // Arrange
    const signIn = recordingSignIn(pendingStart)

    // Act — a bare visit, before any server has been picked.
    await mountLanding('/', { signIn: signIn.stub })

    // Assert — signing in needs a target, so nothing starts and the call to
    // action is absent.
    await waitFor(() => {
      expect(demoServerButton()).toBeDefined()
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

  test('redacts the server it signs in to from telemetry before starting', async () => {
    // Arrange — a custom-domain server, which no fixed rule redacts.
    const signIn = recordingSignIn(pendingStart)

    // Act
    await mountLanding('/?server=https%3A%2F%2Fruth.example', { signIn: signIn.stub })

    // Assert
    await waitFor(() => {
      expect(signIn.started).toEqual(['https://ruth.example'])
    })
    expect(redactServerHostMock).toHaveBeenCalledWith('https://ruth.example')
  })

  test('signs in straight away to the server this tab last signed in to', async () => {
    // Arrange — a reload, or the expiry bounce: the settled URL names no server,
    // but the tab kept the one its last sign-in was redeemed against.
    makeBearerAuthStateStore(window.sessionStorage, SIGNED_IN_SERVER_KEY).writeSession({
      serverUrl: 'https://ruth.relay.wildflowerhealth.io',
      bearer: 'tok_web',
    })
    const signIn = recordingSignIn(pendingStart)

    // Act
    await mountLanding('/', { signIn: signIn.stub })

    // Assert
    await waitFor(() => {
      expect(signIn.started).toEqual(['https://ruth.relay.wildflowerhealth.io'])
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
      bootSignInProblem: {
        reason: 'The authorization request was denied.',
        serverUrl: 'http://127.0.0.1:8080',
      },
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
      bootSignInProblem: {
        reason: 'The token request was rejected: invalid_grant.',
        serverUrl: 'http://127.0.0.1:8080',
      },
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
    // hard-coding it. The secure-page positive is below, and the hint's own
    // rule is `fhir-r4-react/smart`'s `local-network-hint.test.ts`.
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', {
      bootSignInProblem: {
        reason: 'Could not reach the server.',
        serverUrl: 'http://127.0.0.1:8080',
      },
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByText(/Could not reach the server\./)).toBeDefined()
    })
    expect(screen.queryByText(/Local Network Access/)).toBeNull()
  })

  test('names the Local Network Access prompt once for a failed sign-in on arrival', async () => {
    // Arrange — the published (https) page, signing in to a loopback server
    // that the browser held back.
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Failed', reason: 'Could not reach the server.' })
    )

    // Act
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', {
      signIn: signIn.stub,
      secure: true,
    })

    // Assert — the menu's banner carries it after the reason, and only once.
    await waitFor(() => {
      expect(screen.getByText(/Could not reach the server\. .*Local Network Access/)).toBeDefined()
    })
    expect(hintCount()).toBe(1)
  })

  test('names the Local Network Access prompt once for a failed pick of a loopback server', async () => {
    // Arrange — the menu adds the hint to the problems it shows, so the page's
    // `connect` must hand it the bare reason.
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Failed', reason: 'Could not reach the server.' })
    )
    await mountLanding('/', { signIn: signIn.stub, secure: true })

    // Act
    await pickFreeEntry('http://127.0.0.1:8080')

    // Assert
    await waitFor(() => {
      expect(screen.getByText(/Could not reach the server\. .*Local Network Access/)).toBeDefined()
    })
    expect(hintCount()).toBe(1)
  })

  test('names the Local Network Access prompt for a failed boot sign-in to a loopback server', async () => {
    // Arrange / Act — the redemption failed, and the boot pointed `?server=`
    // back at the server the sign-in was to.
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', {
      secure: true,
      bootSignInProblem: {
        reason: 'Could not reach the server.',
        serverUrl: 'http://127.0.0.1:8080',
      },
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByText(/Could not reach the server\. .*Local Network Access/)).toBeDefined()
    })
    expect(hintCount()).toBe(1)
  })

  test('leaves the prompt out for a failed boot sign-in to a remote server', async () => {
    // Arrange / Act — the sign-in that failed was to a hosted server, which has
    // no such prompt.
    await mountLanding(`/?server=${encodeURIComponent(RUTH_SERVER_URL)}`, {
      secure: true,
      bootSignInProblem: {
        reason: 'Could not reach the server.',
        serverUrl: RUTH_SERVER_URL,
      },
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByText('Could not reach the server.')).toBeDefined()
    })
    expect(hintCount()).toBe(0)
  })

  test('sends an already-signed-in reader on to the app', async () => {
    // Arrange — authed before the router mounts, which is what `main-web`'s
    // boot does after it redeems a callback.
    const store = makeBearerAuthStateStore(window.sessionStorage, SIGNED_IN_SERVER_KEY)
    store.writeSession({ serverUrl: 'https://ruth.wildflowerhealth.io', bearer: 'tok_web' })
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
    const appBase = '/pr-719/'
    await mountLanding(appBase, { basepath: appBase, signIn: recordingSignIn(pendingStart).stub })

    // Act — picking a server records `?server=` in the address bar, before
    // the sign-in starts, so before the redirect leaves.
    await pickRelayName('ruth')

    // Assert — the reader stays on the app's own subpath (not moved to `/`), and
    // `?server=` is now set there. A root path would point the parameter at a
    // page that is not this app.
    await waitFor(() => {
      expect(serverUrlFromSearch(window.location.search)).toBe(RUTH_SERVER_URL)
    })
    expect(window.location.pathname).toBe(appBase)
  })

  test('signs in to a relay name’s origin, as a Wildflower server', async () => {
    // Arrange
    const discovery = discoveringStart()
    const signIn = recordingSignIn(discovery.start)
    await mountLanding('/', { signIn: signIn.stub })

    // Act
    await pickRelayName('ruth')

    // Assert — an origin, its FHIR base, so its sign-in discovers there.
    await waitFor(() => {
      expect(signIn.started).toEqual(['https://ruth.relay.wildflowerhealth.io'])
    })
    await waitFor(() => {
      expect(discovery.requested).toEqual([
        'https://ruth.relay.wildflowerhealth.io/.well-known/smart-configuration',
      ])
    })
    expect(serverUrlFromSearch(window.location.search)).toBe(
      'https://ruth.relay.wildflowerhealth.io'
    )
  })

  test('signs in to the demo server at its FHIR base, under its notice', async () => {
    // Arrange — the SmartHealthIT demo is a plain SMART server, so its preset
    // is its FHIR base.
    const discovery = discoveringStart()
    const signIn = recordingSignIn(discovery.start)
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
    expect(discovery.requested).toEqual([`${demoFhirBase}/.well-known/smart-configuration`])
    expect(serverUrlFromSearch(window.location.search)).toBe(demoFhirBase)
  })

  test('signs in to a demo server named by ?server= at its FHIR base, on arrival and on a retry', async () => {
    // Arrange — the page a failed demo pick, or a reload of a demo session,
    // leaves: `?server=` names the demo server's FHIR base, where discovery
    // asks.
    const discovery = discoveringStart()
    const signIn = recordingSignIn(discovery.start)
    const demoDiscovery = `${DEMO_FHIR_BASE}/.well-known/smart-configuration`

    // Act — the sign-in on arrival fails (the stub server is unreachable), and
    // the reader retries from the "Sign in to …" button.
    await mountLanding(`/?server=${encodeURIComponent(DEMO_FHIR_BASE)}`, { signIn: signIn.stub })
    const retry = await screen.findByRole('button', { name: `Sign in to ${DEMO_FHIR_BASE}` })
    await waitFor(() => {
      expect(retry.hasAttribute('disabled')).toBe(false)
    })
    fireEvent.click(retry)

    // Assert
    await waitFor(() => {
      expect(discovery.requested).toEqual([demoDiscovery, demoDiscovery])
    })
  })

  test('shows why a pick failed once, in the menu, with the menu ready for a retry', async () => {
    // Arrange
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Failed', reason: 'Could not reach the server.' })
    )
    await mountLanding('/', { signIn: signIn.stub })
    await waitFor(() => {
      expect(demoServerButton()).toBeDefined()
    })

    // Act
    fireEvent.click(demoServerButton())

    // Assert — one banner, not the menu's and the page's both.
    await waitFor(() => {
      expect(screen.getAllByText(/Could not reach the server\./)).toHaveLength(1)
    })
    expect(demoServerButton().hasAttribute('disabled')).toBe(false)
  })

  test('shows a retried sign-in’s failure once, in place of the one on arrival', async () => {
    // Arrange — the sign-in on arrival failed, and its reason is showing.
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Failed', reason: 'Could not reach the server.' })
    )
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', { signIn: signIn.stub })
    const retry = await screen.findByRole('button', {
      name: /sign in to http:\/\/127\.0\.0\.1:8080/i,
    })
    await waitFor(() => {
      expect(retry.hasAttribute('disabled')).toBe(false)
    })

    // Act
    fireEvent.click(retry)

    // Assert — the retry's failure replaces the first, rather than joining it.
    await waitFor(() => {
      expect(signIn.started).toHaveLength(2)
    })
    await waitFor(() => {
      expect(retry.hasAttribute('disabled')).toBe(false)
    })
    expect(screen.getAllByText(/Could not reach the server\./)).toHaveLength(1)
  })

  test('drops a sign-in that failed before the page loaded once a pick starts another', async () => {
    // Arrange
    await mountLanding('/', {
      bootSignInProblem: {
        reason: 'The token request was rejected: invalid_grant.',
        serverUrl: undefined,
      },
    })
    await waitFor(() => {
      expect(screen.getByText(/invalid_grant/)).toBeDefined()
    })

    // Act
    fireEvent.click(demoServerButton())

    // Assert
    expect(screen.queryByText(/invalid_grant/)).toBeNull()
  })

  test('comes back usable when Back restores the page from the back-forward cache', async () => {
    // Arrange — the sign-in on arrival is leaving for the authorization server,
    // so the "Sign in to …" row and the menu are disabled.
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Ok', value: 'http://127.0.0.1:8080/oauth/authorize?x=1' })
    )
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', { signIn: signIn.stub })
    await waitFor(() => {
      expect(signIn.left).toHaveLength(1)
    })
    const retry = screen.getByRole('button', { name: /taking you to sign in/i })
    expect(retry.hasAttribute('disabled')).toBe(true)

    // Act — the reader pressed Back at the authorization server.
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })

    // Assert
    expect(
      screen
        .getByRole('button', { name: /sign in to http:\/\/127\.0\.0\.1:8080/i })
        .hasAttribute('disabled')
    ).toBe(false)
    expect(demoServerButton().hasAttribute('disabled')).toBe(false)
  })

  test('signs in on arrival with the EHR launch the page was opened with, once', async () => {
    // Arrange — `main-web`'s boot read `?iss=…&launch=…` and pointed
    // `?server=` at the server `iss` names. Under StrictMode, whose second
    // effect run must not start a second sign-in with a single-use launch.
    const signIn = recordingSignIn(pendingStart)

    // Act
    await mountLanding(`/?server=${encodeURIComponent(RUTH_SERVER_URL)}`, {
      signIn: signIn.stub,
      ehrLaunch: unsentEhrLaunch({ serverUrl: RUTH_SERVER_URL, launch: 'nonce-1' }),
      strict: true,
    })

    // Assert
    await waitFor(() => {
      expect(signIn.started).toEqual([RUTH_SERVER_URL])
    })
    expect(signIn.launches).toEqual(['nonce-1'])
  })

  test('carries the EHR launch on the first sign-in only', async () => {
    // Arrange — the sign-in on arrival fails, and the reader retries.
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Failed', reason: 'Could not reach the server.' })
    )
    await mountLanding(`/?server=${encodeURIComponent(RUTH_SERVER_URL)}`, {
      signIn: signIn.stub,
      ehrLaunch: unsentEhrLaunch({ serverUrl: RUTH_SERVER_URL, launch: 'nonce-1' }),
    })
    const retry = await screen.findByRole('button', { name: `Sign in to ${RUTH_SERVER_URL}` })
    await waitFor(() => {
      expect(retry.hasAttribute('disabled')).toBe(false)
    })

    // Act
    fireEvent.click(retry)

    // Assert — the retry is a standalone launch rather than a second offer of
    // a launch the authorization server may already have spent.
    await waitFor(() => {
      expect(signIn.launches).toEqual(['nonce-1', undefined])
    })
  })

  test('does not offer the EHR launch again when the landing mounts again', async () => {
    // Arrange — the sign-in on arrival fails before leaving the page, and the
    // landing is then mounted afresh, as on a route change back to it. The
    // launch is held once per page load, by `main-web`'s boot.
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Failed', reason: 'Could not reach the server.' })
    )
    const ehrLaunch = unsentEhrLaunch({ serverUrl: RUTH_SERVER_URL, launch: 'nonce-1' })
    await mountLanding(`/?server=${encodeURIComponent(RUTH_SERVER_URL)}`, {
      signIn: signIn.stub,
      ehrLaunch,
    })
    await waitFor(() => {
      expect(signIn.launches).toEqual(['nonce-1'])
    })
    cleanup()

    // Act
    await mountLanding(`/?server=${encodeURIComponent(RUTH_SERVER_URL)}`, {
      signIn: signIn.stub,
      ehrLaunch,
    })

    // Assert — the second landing signs in on arrival too, standalone.
    await waitFor(() => {
      expect(signIn.launches).toEqual(['nonce-1', undefined])
    })
  })

  test('refuses a launch to a server this page cannot reach, and keeps it off other servers', async () => {
    // Arrange — the published (https) page, launched against a plain-http
    // server that is not loopback.
    const signIn = recordingSignIn(pendingStart)
    const insecureServerUrl = 'http://example.org'
    await mountLanding(`/?server=${encodeURIComponent(insecureServerUrl)}`, {
      signIn: signIn.stub,
      ehrLaunch: unsentEhrLaunch({ serverUrl: insecureServerUrl, launch: 'nonce-1' }),
      secure: true,
    })

    // Assert — nothing starts on arrival, and the row says why.
    await waitFor(() => {
      expect(
        screen
          .getByRole('button', { name: `Sign in to ${insecureServerUrl}` })
          .hasAttribute('disabled')
      ).toBe(true)
    })
    expect(signIn.started).toEqual([])

    // Act — the reader picks the relay server instead.
    await pickRelayName('ruth')

    // Assert — that sign-in is a standalone one.
    await waitFor(() => {
      expect(signIn.started).toEqual([RUTH_SERVER_URL])
    })
    expect(signIn.launches).toEqual([undefined])
  })

  test('shows a rejected launch on the landing, with its server still offered', async () => {
    // Arrange / Act — the authorization server refused the launch and redirected back, and
    // `main-web`'s boot pointed `?server=` back at the server it was to.
    const signIn = recordingSignIn(pendingStart)
    await mountLanding(`/?server=${encodeURIComponent(RUTH_SERVER_URL)}`, {
      signIn: signIn.stub,
      bootSignInProblem: {
        reason:
          'The server refused the sign-in: The supplied launch is unknown, already used, expired, or for another app.',
        serverUrl: RUTH_SERVER_URL,
      },
    })

    // Assert — the reason shows beside a sign-in to that server, and nothing
    // starts on arrival.
    await waitFor(() => {
      expect(screen.getByText(/The supplied launch is unknown/)).toBeDefined()
    })
    expect(screen.getByRole('button', { name: `Sign in to ${RUTH_SERVER_URL}` })).toBeDefined()
    expect(signIn.started).toEqual([])
  })

  test('keeps the menu disabled while the sign-in on arrival is in flight', async () => {
    // Arrange / Act — a named server, whose sign-in never settles.
    const signIn = recordingSignIn(pendingStart)
    await mountLanding('/?server=http%3A%2F%2F127.0.0.1%3A8080', { signIn: signIn.stub })

    // Assert — a pick now would start a second flow over the first.
    await waitFor(() => {
      expect(signIn.started).toEqual(['http://127.0.0.1:8080'])
    })
    expect(demoServerButton().hasAttribute('disabled')).toBe(true)
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
    readonly bootSignInProblem?: SignInProblem
    readonly ehrLaunch?: UnsentEhrLaunch
    /** Mount under `StrictMode`, which runs each effect twice. */
    readonly strict?: boolean
    /**
     * Router basepath, when `url` is under a subpath rather than the origin
     * root — mirrors what `main-web` passes so `/` still resolves the landing
     * there. See `web-basepath.test.tsx`.
     */
    readonly basepath?: string
    /** The sign-in stand-in; a never-settling one by default, so no test reaches the network. */
    readonly signIn?: LandingSignIn
    /**
     * Whether the page is the published one, served over https. jsdom's own
     * page is plain http, so `location` is stubbed with the same `url` there.
     */
    readonly secure?: boolean
  } = {}
): Promise<{ readonly pathname: () => string }> => {
  window.history.replaceState(null, '', url)
  if (options.secure === true) {
    vi.stubGlobal('location', new URL(url, 'https://wildflowerhealth.io'))
  }

  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <Landing
        bootSignInProblem={options.bootSignInProblem}
        ehrLaunch={options.ehrLaunch}
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

  const tree = (
    <AuthStateProvider
      store={options.store ?? makeBearerAuthStateStore(window.sessionStorage, SIGNED_IN_SERVER_KEY)}
    >
      <RouterProvider router={router} />
    </AuthStateProvider>
  )
  render(options.strict === true ? <StrictMode>{tree}</StrictMode> : tree)
  await waitFor(() => {
    expect(router.state.status).toBe('idle')
  })
  return { pathname: () => router.state.location.pathname }
}

/** A relayed Wildflower server's origin. */
const RUTH_SERVER_URL = 'https://ruth.relay.wildflowerhealth.io'

/** The menu's group names this page is driven through (`smart-app-react`'s presets). */
const RELAY_GROUP_NAME = 'Official Wildflower Relay'
const DEMO_GROUP_NAME = 'Smart Health IT Demo Server'

/** A SmartHealthIT demo FHIR base, the shape the demo group's presets have. */
const DEMO_FHIR_BASE = 'https://launch.smarthealthit.org/v/r4/sim/WzMsIiJd/fhir'

/**
 * How many times the page names the Local Network Access prompt, counted in its
 * text rather than by element: a hint added twice lands in one banner.
 */
const hintCount = (): number =>
  (document.body.textContent ?? '').match(/Local Network Access/g)?.length ?? 0

/** The menu's one-click sign-in to the demo server: the pick these tests make when any will do. */
const demoServerButton = (): HTMLElement =>
  within(screen.getByRole('region', { name: DEMO_GROUP_NAME })).getByRole('button', {
    name: 'Launch as logged in patient',
  })

/** Pick the server named `relayName` through the menu's relay entry. */
const pickRelayName = async (relayName: string): Promise<void> => {
  const relay = within(await screen.findByRole('form', { name: RELAY_GROUP_NAME }))
  fireEvent.change(relay.getByLabelText('Official Wildflower Relay Name'), {
    target: { value: relayName },
  })
  fireEvent.click(relay.getByRole('button', { name: 'Connect' }))
}

/** Pick the server at `serverUrl` through the menu's free entry. */
const pickFreeEntry = async (serverUrl: string): Promise<void> => {
  const freeEntry = within(await screen.findByRole('form', { name: 'Another Wildflower server' }))
  fireEvent.change(freeEntry.getByLabelText('Server URL'), { target: { value: serverUrl } })
  fireEvent.click(freeEntry.getByRole('button', { name: 'Connect' }))
}

/** A sign-in start that never settles — the page stays "taking you to sign in". */
const pendingStart = (): Promise<SignInStep<string>> => new Promise(() => {})

/**
 * The real sign-in start, `startSignIn`, run against a published page whose
 * `fetch` records each URL asked for — so a test sees where discovery went.
 * Every request fails as an unreachable server's would, so the start fails
 * there.
 */
const discoveringStart = (): {
  readonly start: (target: string) => Promise<SignInStep<string>>
  readonly requested: string[]
} => {
  const requested: string[] = []
  const pending = new Map<string, string>()
  const environment = signInEnvironment({
    fetch: (input) => {
      const url = input instanceof Request ? input.url : String(input)
      requested.push(url)
      return Promise.reject(new TypeError('Failed to fetch'))
    },
    crypto: globalThis.crypto,
    sessionStorage: {
      getItem: (key) => pending.get(key) ?? null,
      setItem: (key, value) => {
        pending.set(key, value)
      },
      removeItem: (key) => {
        pending.delete(key)
      },
    },
    location: { href: 'https://launcher.wildflowerhealth.io/', protocol: 'https:' },
  })
  return { start: (target) => startSignIn(target, undefined, environment), requested }
}

/**
 * A {@link LandingSignIn} stand-in that records each target, the EHR launch
 * each sign-in carried, and each departure.
 */
const recordingSignIn = (
  start: (target: string) => Promise<SignInStep<string>>
): {
  readonly stub: LandingSignIn
  readonly started: string[]
  readonly launches: (string | undefined)[]
  readonly left: string[]
} => {
  const started: string[] = []
  const launches: (string | undefined)[] = []
  const left: string[] = []
  return {
    started,
    launches,
    left,
    stub: {
      start: (target, launch) => {
        started.push(target)
        launches.push(launch)
        return start(target)
      },
      leave: (authorizationUrl) => {
        left.push(authorizationUrl)
      },
    },
  }
}
