import { createBrowserHistory } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type * as SmartClientModule from '@wildflowerhealthio/authorization-core/smart-client'
import { PlainSmartServer, type Session } from '@wildflowerhealthio/authorization-core/smart-client'
import { TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import { authorizeSmartLaunch } from '@wildflowerhealthio/fhir-r4-react/smart'
import { writeConsent } from '@wildflowerhealthio/telemetry-core'
import type * as TelemetryWeb from '@wildflowerhealthio/telemetry-web'
import { Effect, Option } from 'effect'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vite-plus/test'

import { AppRoot } from './app-root.tsx'
import { smartRegistration } from './config.ts'
import { BASEPATH, setUpEachAppTest } from './test-utils/app-fakes.ts'

// The real app root, app and router over the real URL, with the sign-in's
// two halves stubbed at `authorization-core`'s boundary: `beginSignIn` is the
// authorize a launch starts, `completeSignIn` the token exchange on the
// callback. Pins that the router never touches a URL the launch or the
// exchange still reads.
const { beginSignInMock, completeSignInMock } = vi.hoisted(() => ({
  beginSignInMock: vi.fn<typeof SmartClientModule.beginSignIn>(),
  completeSignInMock: vi.fn<typeof SmartClientModule.completeSignIn>(),
}))
vi.mock('@wildflowerhealthio/authorization-core/smart-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SmartClientModule>()),
  beginSignIn: beginSignInMock,
  completeSignIn: completeSignInMock,
}))

// Telemetry never starts: the stored answer declines it.
vi.mock('@wildflowerhealthio/telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  initConsentedTelemetry: () => false,
}))

/** The FHIR server the stub client reads. */
const FHIR_SERVER_URL = 'https://fhir.example/r4'

/** An EHR launch, as a launcher opens the app with it. */
const EHR_LAUNCH = `?iss=${encodeURIComponent(FHIR_SERVER_URL)}&launch=xyz`

/** The session a completed exchange redeems: a launch with patient `p1` in context. */
const SESSION: Session = {
  accessToken: 'token',
  scope: smartRegistration.scope,
  serverUrl: FHIR_SERVER_URL,
  smartServer: PlainSmartServer.make({ fhirBaseUrl: FHIR_SERVER_URL }),
  expiresInSeconds: undefined,
  patient: 'p1',
  returnTo: undefined,
}

/**
 * The FHIR server's reads: the patient read answers the patient, and every
 * search an empty bundle.
 */
const answerFhirRead = (input: RequestInfo | URL): Promise<Response> =>
  Promise.resolve(
    Response.json(
      String(input instanceof Request ? input.url : input).startsWith(`${FHIR_SERVER_URL}/Patient/`)
        ? { resourceType: 'Patient', id: 'p1', name: [{ given: ['Ada'], family: 'Lovelace' }] }
        : { resourceType: 'Bundle', type: 'searchset', entry: [] }
    )
  )

/**
 * Let a launch's authorize through: `beginSignIn` yields an authorize URL on
 * this page (a fragment, so jsdom does not navigate), and the launch keeps
 * what its callback needs.
 */
const letAuthorizeThrough = (): void => {
  beginSignInMock.mockImplementation(() =>
    Effect.sync(() => `${window.location.href.split('#')[0] ?? ''}#authorize`)
  )
}

/** Start a sign-in as the launch page does, so a callback has a connection to complete. */
const startSignIn = async (): Promise<void> => {
  letAuthorizeThrough()
  await authorizeSmartLaunch(
    {
      ...smartRegistration,
      redirectUri: `${window.location.origin}${BASEPATH}`,
      iss: FHIR_SERVER_URL,
    },
    'xyz'
  )
}

/**
 * Render the app root at the address bar as it is, over a browser history the
 * test destroys as it finishes.
 */
const renderAppRoot = (): void => {
  const history = createBrowserHistory()
  onTestFinished(() => {
    history.destroy()
  })
  render(<AppRoot page={{ basepath: BASEPATH, history }} />)
}

/** The address bar's path and query. */
const addressBar = (): string => `${window.location.pathname}${window.location.search}`

setUpEachAppTest()

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(answerFhirRead))
  // A returning visitor's answer, so the page is past the consent dialog.
  writeConsent(window.localStorage, {
    version: TELEMETRY_CONSENT_COPY.version,
    crashReports: false,
    performance: false,
    decidedAt: '2026-09-29T12:00:00.000Z',
  })
})

afterEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  beginSignInMock.mockReset()
  completeSignInMock.mockReset()
  vi.unstubAllGlobals()
})

describe('AppRoot over the address bar', () => {
  it.each([
    { case: 'at the app root', route: '' },
    { case: 'at a patient’s tab, two directories deep', route: 'patients/p1/calendar' },
  ])('should start a launch URL’s launch $case, returning to the app root', async ({ route }) => {
    // Arrange: the authorize URL never arrives, so the page never leaves.
    beginSignInMock.mockReturnValue(Effect.never)
    const launchUrl = `${BASEPATH}${route}${EHR_LAUNCH}`
    window.history.replaceState(null, '', launchUrl)

    // Act
    renderAppRoot()

    // Assert
    await waitFor(() => {
      expect(beginSignInMock).toHaveBeenCalledTimes(1)
    })
    expect(beginSignInMock.mock.calls[0]?.[2].redirectUri).toBe(
      `${window.location.origin}${BASEPATH}`
    )
    expect(addressBar()).toBe(launchUrl)
  })

  it('should leave the callback URL alone through the exchange, then open the launch’s patient', async () => {
    // Arrange: a sign-in out, and an exchange the test completes
    await startSignIn()
    let completeExchange: () => void = () => {}
    completeSignInMock.mockReturnValue(
      Effect.promise(
        () =>
          new Promise<Option.Option<Session>>((resolve) => {
            completeExchange = () => {
              resolve(Option.some(SESSION))
            }
          })
      )
    )
    const callbackUrl = `${BASEPATH}?code=abc&state=xyz`
    window.history.replaceState(null, '', callbackUrl)
    renderAppRoot()
    await waitFor(() => {
      expect(completeSignInMock).toHaveBeenCalledTimes(1)
    })
    expect(addressBar()).toBe(callbackUrl)

    // Act
    completeExchange()

    // Assert
    expect(await screen.findByText('No medications found.')).toBeDefined()
    expect(addressBar()).toBe(`${BASEPATH}patients/p1/medications`)
    expect(completeSignInMock).toHaveBeenCalledTimes(1)
  })

  it('should open the tab a launch started on once its exchange completes', async () => {
    // Arrange: a launch at a patient's calendar leaves for the authorization
    // server.
    letAuthorizeThrough()
    window.history.replaceState(null, '', `${BASEPATH}patients/p1/calendar${EHR_LAUNCH}`)
    renderAppRoot()
    await waitFor(() => {
      expect(window.location.hash).toBe('#authorize')
    })
    cleanup()
    // The callback returns to the app root, and the exchange redeems the code.
    completeSignInMock.mockReturnValue(Effect.succeed(Option.some(SESSION)))
    window.history.replaceState(null, '', `${BASEPATH}?code=abc&state=xyz`)

    // Act
    renderAppRoot()

    // Assert
    expect(await screen.findByRole('button', { name: 'Next month' })).toBeDefined()
    expect(addressBar()).toBe(`${BASEPATH}patients/p1/calendar`)
  })
})
