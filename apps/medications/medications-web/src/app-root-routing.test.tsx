import { createBrowserHistory } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import { writeConsent } from '@wildflowerhealthio/telemetry-core'
import type * as TelemetryWeb from '@wildflowerhealthio/telemetry-web'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vite-plus/test'

import { AppRoot } from './app-root.tsx'
import { BASEPATH, setUpEachAppTest } from './test-utils/app-fakes.ts'

// The real app root, app and router over the real URL, with fhirclient's
// OAuth calls stubbed at the module boundary: `authorize` is the redirect a
// launch starts, `ready` the token exchange on the callback. Pins that the
// router never touches a URL the launch or the exchange still reads.
const { authorizeMock, readyMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn<(params: Record<string, unknown>) => Promise<string | void>>(),
  readyMock: vi.fn<() => Promise<unknown>>(),
}))
vi.mock('fhirclient/browser', () => ({
  default: { oauth2: { ready: readyMock, authorize: authorizeMock } },
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

/**
 * The client a completed exchange hands the app: a launch with patient `p1`
 * in context, whose server answers the patient read with the patient and
 * every search with an empty bundle.
 */
const readyClient = {
  patient: { id: 'p1' },
  state: { serverUrl: FHIR_SERVER_URL, tokenResponse: { access_token: 'token' } },
  request: (url: string): Promise<unknown> =>
    Promise.resolve(
      url.startsWith('Patient/')
        ? { resourceType: 'Patient', id: 'p1', name: [{ given: ['Ada'], family: 'Lovelace' }] }
        : { resourceType: 'Bundle', type: 'searchset', entry: [] }
    ),
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
  authorizeMock.mockReset()
  readyMock.mockReset()
})

describe('AppRoot over the address bar', () => {
  it.each([
    { case: 'at the app root', route: '' },
    { case: 'at a patient’s tab, two directories deep', route: 'patients/p1/calendar' },
  ])('should start a launch URL’s launch $case, returning to the app root', async ({ route }) => {
    // Arrange: the authorize URL never arrives, so the page never leaves.
    authorizeMock.mockReturnValue(new Promise(() => {}))
    const launchUrl = `${BASEPATH}${route}${EHR_LAUNCH}`
    window.history.replaceState(null, '', launchUrl)

    // Act
    renderAppRoot()

    // Assert
    await waitFor(() => {
      expect(authorizeMock).toHaveBeenCalledTimes(1)
    })
    expect(authorizeMock.mock.calls[0]?.[0]).toMatchObject({
      redirectUri: `${window.location.origin}${BASEPATH}`,
    })
    expect(addressBar()).toBe(launchUrl)
  })

  it('should leave the callback URL alone through the exchange, then open the launch’s patient', async () => {
    // Arrange: an exchange the test completes, taking `code` and `state` out
    // of the address bar as fhirclient does.
    let completeExchange: () => void = () => {}
    readyMock.mockReturnValue(
      new Promise((resolve) => {
        completeExchange = () => {
          window.history.replaceState(window.history.state, '', BASEPATH)
          resolve(readyClient)
        }
      })
    )
    const callbackUrl = `${BASEPATH}?code=abc&state=xyz`
    window.history.replaceState(null, '', callbackUrl)
    renderAppRoot()
    await waitFor(() => {
      expect(readyMock).toHaveBeenCalledTimes(1)
    })
    expect(addressBar()).toBe(callbackUrl)

    // Act
    completeExchange()

    // Assert
    expect(await screen.findByText('No medications found.')).toBeDefined()
    expect(addressBar()).toBe(`${BASEPATH}patients/p1/medications`)
    expect(readyMock).toHaveBeenCalledTimes(1)
  })

  it('should open the tab a launch started on once its exchange completes', async () => {
    // Arrange: a launch at a patient's calendar leaves for the authorization
    // server (the authorize URL never arrives).
    authorizeMock.mockReturnValue(new Promise(() => {}))
    window.history.replaceState(null, '', `${BASEPATH}patients/p1/calendar${EHR_LAUNCH}`)
    renderAppRoot()
    await waitFor(() => {
      expect(authorizeMock).toHaveBeenCalledTimes(1)
    })
    cleanup()
    // The callback returns to the app root, and the exchange takes `code`
    // and `state` out of the address bar as fhirclient does.
    readyMock.mockImplementation(() => {
      window.history.replaceState(window.history.state, '', BASEPATH)
      return Promise.resolve(readyClient)
    })
    window.history.replaceState(null, '', `${BASEPATH}?code=abc&state=xyz`)

    // Act
    renderAppRoot()

    // Assert
    expect(await screen.findByRole('button', { name: 'Next month' })).toBeDefined()
    expect(addressBar()).toBe(`${BASEPATH}patients/p1/calendar`)
  })
})
