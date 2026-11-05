import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type * as SmartClientModule from '@wildflowerhealthio/authorization-core/smart-client'
import { PlainSmartServer, type Session } from '@wildflowerhealthio/authorization-core/smart-client'
import { TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import { decodeFhirBaseUrl, redirectToSignIn } from '@wildflowerhealthio/fhir-r4-react/smart'
import { writeConsent } from '@wildflowerhealthio/telemetry-core'
import type * as TelemetryWeb from '@wildflowerhealthio/telemetry-web'
import { Effect, Option } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { AppRoot } from './app-root.tsx'
import { smartRegistration } from './config.ts'
import { BASEPATH, pageAt, stubPageBrowserApis } from './importer-app.test-helpers.ts'

// The real app root, app and router over the real URL, with the sign-in's
// two halves stubbed at `authorization-core`'s boundary: `beginSignInAt` is the
// authorize the sign-in starts, `completeSignIn` the token exchange on the
// callback. Pins that the router never touches the callback URL the exchange
// still reads.
const { beginSignInAtMock, completeSignInMock } = vi.hoisted(() => ({
  beginSignInAtMock: vi.fn<typeof SmartClientModule.beginSignInAt>(),
  completeSignInMock: vi.fn<typeof SmartClientModule.completeSignIn>(),
}))
vi.mock('@wildflowerhealthio/authorization-core/smart-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SmartClientModule>()),
  beginSignInAt: beginSignInAtMock,
  completeSignIn: completeSignInMock,
}))

// Telemetry never starts: the stored answer declines it.
vi.mock('@wildflowerhealthio/telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  initConsentedTelemetry: () => false,
}))

/** The FHIR server the completed exchange names. */
const FHIR_SERVER_URL = 'https://fhir.example/r4'

/** The FHIR server's SMART configuration, which a sign-in probes before it authorizes. */
const SMART_CONFIGURATION = {
  authorization_endpoint: 'https://fhir.example/oauth/authorize',
  token_endpoint: 'https://fhir.example/oauth/token',
  code_challenge_methods_supported: ['S256'],
}

/** The session a completed exchange redeems. */
const SESSION: Session = {
  accessToken: 'token',
  scope: smartRegistration.scope,
  serverUrl: FHIR_SERVER_URL,
  smartServer: PlainSmartServer.make({ fhirBaseUrl: FHIR_SERVER_URL }),
  expiresInSeconds: undefined,
  patient: undefined,
  returnTo: undefined,
}

/**
 * Start a sign-in as the connect menu does, so the callback has a connection
 * to complete: `beginSignInAt` yields an authorize URL on this page (a
 * fragment, so jsdom does not navigate).
 */
const startSignIn = async (): Promise<void> => {
  beginSignInAtMock.mockImplementation(() =>
    Effect.sync(() => `${window.location.href.split('#')[0] ?? ''}#authorize`)
  )
  await Effect.runPromise(
    redirectToSignIn(
      {
        ...smartRegistration,
        redirectUri: `${window.location.origin}${BASEPATH}`,
        fhirBaseUrl: decodeFhirBaseUrl(FHIR_SERVER_URL),
      },
      undefined
    )
  )
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
  // The FHIR server serves its SMART configuration and holds no source files:
  // every search is an empty bundle.
  vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
    Promise.resolve(
      String(input instanceof Request ? input.url : input).endsWith(
        '/.well-known/smart-configuration'
      )
        ? Response.json(SMART_CONFIGURATION)
        : new Response(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: [] }), {
            status: 200,
            headers: { 'content-type': 'application/fhir+json' },
          })
    )
  )
  return stubPageBrowserApis()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
  beginSignInAtMock.mockReset()
  completeSignInMock.mockReset()
})

describe('AppRoot over the address bar', () => {
  it('should take the callback out of the URL, route nothing through the exchange, then open Import', async () => {
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
    const page = pageAt('?code=abc&state=xyz')
    const callbackUrl = addressBar()
    render(<AppRoot page={page} />)
    await waitFor(() => {
      expect(completeSignInMock).toHaveBeenCalledTimes(1)
    })
    // The connection in progress is taken, and its callback with it, before
    // the code is redeemed; nothing else moves the address bar meanwhile.
    expect(addressBar()).toBe(callbackUrl.replace('?code=abc&state=xyz', ''))

    // Act
    completeExchange()

    // Assert
    expect(await screen.findByRole('region', { name: 'File source' })).toBeDefined()
    expect(addressBar()).toBe(`${BASEPATH}import`)
    expect(completeSignInMock).toHaveBeenCalledTimes(1)
  })
})
