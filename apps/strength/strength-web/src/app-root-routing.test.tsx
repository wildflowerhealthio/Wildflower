import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import { writeConsent } from '@wildflowerhealthio/telemetry-core'
import type * as TelemetryWeb from '@wildflowerhealthio/telemetry-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { AppRoot } from './app-root.tsx'

// The real app root, app and router over the real URL, with fhirclient's
// OAuth calls stubbed at the module boundary: `authorize` is the redirect a
// launch starts, `ready` the token exchange on the callback. Pins that the
// router never touches a URL the launch or the exchange still reads.
const { authorizeMock, readyMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn<(params: Record<string, unknown>) => Promise<string | void>>(),
  readyMock: vi.fn<() => Promise<unknown>>(),
}))
vi.mock('fhirclient', () => ({
  default: { oauth2: { ready: readyMock, authorize: authorizeMock } },
}))

// Telemetry never starts: the stored answer declines it.
vi.mock('@wildflowerhealthio/telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  initConsentedTelemetry: () => false,
}))

/** The directory the app is served from in these tests. */
const BASEPATH = '/strength/'

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

/** A `ResizeObserver` that never fires: the page's `RouteTabs` observes its strip. */
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** The address bar's path and query. */
const addressBar = (): string => `${window.location.pathname}${window.location.search}`

beforeEach(() => {
  // A returning visitor's answer, so the page is past the consent dialog.
  writeConsent(window.localStorage, {
    version: TELEMETRY_CONSENT_COPY.version,
    crashReports: false,
    performance: false,
    decidedAt: '2026-09-29T12:00:00.000Z',
  })
  vi.stubGlobal('ResizeObserver', InertResizeObserver)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  Element.prototype.scrollTo = () => {}
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(Element.prototype, 'scrollTo')
  authorizeMock.mockReset()
  readyMock.mockReset()
})

describe('AppRoot over the address bar', () => {
  it.each([
    { case: 'at the app root', route: '' },
    { case: 'at a tab', route: 'plan' },
  ])('should start a launch URL’s launch $case, returning to the app root', async ({ route }) => {
    // Arrange: the authorize URL never arrives, so the page never leaves.
    authorizeMock.mockReturnValue(new Promise(() => {}))
    const launchUrl = `${BASEPATH}${route}${EHR_LAUNCH}`
    window.history.replaceState(null, '', launchUrl)

    // Act
    render(<AppRoot basepath={BASEPATH} />)

    // Assert
    await waitFor(() => {
      expect(authorizeMock).toHaveBeenCalledTimes(1)
    })
    expect(authorizeMock.mock.calls[0]?.[0]).toMatchObject({
      redirectUri: `${window.location.origin}${BASEPATH}`,
    })
    expect(addressBar()).toBe(launchUrl)
  })

  it('should leave the callback URL alone through the exchange, then open Today', async () => {
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
    render(<AppRoot basepath={BASEPATH} />)
    await waitFor(() => {
      expect(readyMock).toHaveBeenCalledTimes(1)
    })
    expect(addressBar()).toBe(callbackUrl)

    // Act
    completeExchange()

    // Assert
    expect(await screen.findByRole('button', { name: 'Start program' })).toBeDefined()
    expect(addressBar()).toBe(`${BASEPATH}today`)
    expect(readyMock).toHaveBeenCalledTimes(1)
  })
})
