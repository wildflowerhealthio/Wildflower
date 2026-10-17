import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import { writeConsent } from '@wildflowerhealthio/telemetry-core'
import type * as TelemetryWeb from '@wildflowerhealthio/telemetry-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { AppRoot } from './app-root.tsx'
import {
  BASEPATH,
  pageAt,
  restorePageBrowserApis,
  stubPageBrowserApis,
} from './importer-app.test-helpers.ts'

// The real app root, app and router over the real URL, with fhirclient's
// token exchange stubbed at the module boundary. Pins that the router never
// touches the callback URL the exchange still reads.
const { readyMock } = vi.hoisted(() => ({
  readyMock: vi.fn<() => Promise<unknown>>(),
}))
vi.mock('fhirclient', () => ({
  default: { oauth2: { ready: readyMock, authorize: vi.fn() } },
}))

// Telemetry never starts: the stored answer declines it.
vi.mock('@wildflowerhealthio/telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  initConsentedTelemetry: () => false,
}))

/** The FHIR server the completed exchange names. */
const FHIR_SERVER_URL = 'https://fhir.example/r4'

/** The client a completed exchange hands the app. */
const readyClient = {
  state: { serverUrl: FHIR_SERVER_URL, tokenResponse: { access_token: 'token' } },
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
  stubPageBrowserApis()
  // The FHIR server holds no source files: every search is an empty bundle.
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: [] }), {
        status: 200,
        headers: { 'content-type': 'application/fhir+json' },
      })
    )
  )
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  restorePageBrowserApis()
  readyMock.mockReset()
})

describe('AppRoot over the address bar', () => {
  it('should leave the callback URL alone through the exchange, then open Import', async () => {
    // Arrange: an exchange the test completes, taking `code` and `state` out
    // of the address bar as fhirclient does: over an empty state, which drops
    // the tags the browser history gave the entry.
    let completeExchange: () => void = () => {}
    readyMock.mockReturnValue(
      new Promise((resolve) => {
        completeExchange = () => {
          window.history.replaceState({}, '', BASEPATH)
          resolve(readyClient)
        }
      })
    )
    const page = pageAt('?code=abc&state=xyz')
    const callbackUrl = addressBar()
    render(<AppRoot page={page} />)
    await waitFor(() => {
      expect(readyMock).toHaveBeenCalledTimes(1)
    })
    expect(addressBar()).toBe(callbackUrl)

    // Act
    completeExchange()

    // Assert
    expect(await screen.findByRole('region', { name: 'File source' })).toBeDefined()
    expect(addressBar()).toBe(`${BASEPATH}import`)
    expect(readyMock).toHaveBeenCalledTimes(1)
  })
})
