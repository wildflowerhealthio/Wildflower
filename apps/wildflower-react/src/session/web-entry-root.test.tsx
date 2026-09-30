import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TELEMETRY_CONSENT_COPY } from 'branding-core'
import { StrictMode, type JSX, type ReactNode } from 'react'
import { ItemList } from 'react-tundraish'
import type * as TelemetryWeb from 'telemetry-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  answerDialog,
  openDialog,
  restoreDialogModality,
  storeConsent,
  stubDialogModality,
} from './telemetry-consent.test-helpers.ts'
import { useTelemetrySettingsItems } from './telemetry-settings-items.ts'
import { WebEntryRoot } from './web-entry-root.tsx'

/** The part of Sentry's `captureException` hint the boot boundary sets. */
interface CaptureHint {
  readonly extra?: { readonly componentStack?: string }
}

// Starting the SDK and reporting through it are the collaborators whose every
// touch the gate controls, so the module boundary is where they are stubbed:
// each test reads back whether, when and with what the root started
// telemetry. The rest of the module stays real, so the config is the one the
// owner UI's web entry builds.
const { initConsentedTelemetryMock, captureExceptionMock } = vi.hoisted(() => ({
  initConsentedTelemetryMock: vi.fn<typeof TelemetryWeb.initConsentedTelemetry>(() => false),
  captureExceptionMock: vi.fn<(exception: unknown, hint?: CaptureHint) => string>(() => 'event-id'),
}))
vi.mock('telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  initConsentedTelemetry: initConsentedTelemetryMock,
  Sentry: { captureException: captureExceptionMock },
}))

const OWNER_UI_DSN = 'https://key@sentry.example/11'
const SETTINGS_ROW_NAME = /^Telemetry/

/** Matches the Telemetry settings row's accessible name when it reads `summary`. */
const settingsRowReading =
  (summary: string) =>
  (accessibleName: string): boolean =>
    accessibleName.startsWith('Telemetry') && accessibleName.endsWith(summary)

beforeEach(() => {
  stubDialogModality()
  vi.stubEnv('VITE_SENTRY_DSN_WILDFLOWER_REACT', OWNER_UI_DSN)
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  restoreDialogModality()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

describe('WebEntryRoot', () => {
  it('should show only the consent dialog, boot nothing and start nothing, until the visitor answers', async () => {
    // Arrange
    const bootApp = vi.fn(bootsTo(<div data-testid="app" />))

    // Act
    await renderRoot(bootApp)

    // Assert — the dialog alone: no sign-in redeemed, no router, no Sentry
    expect(openDialog()).not.toBeNull()
    expect(bootApp).not.toHaveBeenCalled()
    expect(initConsentedTelemetryMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('should start telemetry with the owner UI’s DSN and tags, then boot the app, once the visitor answers', async () => {
    // Arrange
    const bootApp = vi.fn(bootsTo(<div data-testid="app" />))
    await renderRoot(bootApp)

    // Act
    await answerDialogAndSettle({ crashReports: true, performance: true })

    // Assert
    expect(await screen.findByTestId('app')).toBeDefined()
    expect(initConsentedTelemetryMock).toHaveBeenCalledTimes(1)
    const [{ consent, config, tags }] = initConsentedTelemetryMock.mock.calls[0]
    expect(consent).toMatchObject({ crashReports: true, performance: true })
    expect(config.sentry.dsn).toBe(OWNER_UI_DSN)
    expect(config.otel.serviceName).toBe('wildflower-react')
    expect(tags).toStrictEqual({ app: 'wildflower-react', entry: 'main-web' })
    expect(bootApp).toHaveBeenCalledTimes(1)
    expect(initConsentedTelemetryMock.mock.invocationCallOrder[0]).toBeLessThan(
      bootApp.mock.invocationCallOrder[0]
    )
  })

  it('should start telemetry from a stored yes before it boots the app, and boot it once under StrictMode', async () => {
    // Arrange — a returning visitor
    storeConsent({ crashReports: true, performance: false })
    const bootApp = vi.fn(bootsTo(<div data-testid="app" />))

    // Act
    await renderRoot(bootApp)

    // Assert — no dialog; Sentry first, then the one boot that builds the router
    expect(await screen.findByTestId('app')).toBeDefined()
    expect(openDialog()).toBeNull()
    expect(bootApp).toHaveBeenCalledTimes(1)
    expect(initConsentedTelemetryMock).toHaveBeenCalled()
    expect(initConsentedTelemetryMock.mock.calls[0][0].consent).toMatchObject({
      crashReports: true,
      performance: false,
    })
    expect(initConsentedTelemetryMock.mock.invocationCallOrder[0]).toBeLessThan(
      bootApp.mock.invocationCallOrder[0]
    )
  })

  it('should boot the app on a stored no, handing telemetry the declined answer', async () => {
    // Arrange
    storeConsent({ crashReports: false, performance: false })
    const bootApp = vi.fn(bootsTo(<div data-testid="app" />))

    // Act
    await renderRoot(bootApp)

    // Assert — `initConsentedTelemetry` starts nothing for a declined answer
    expect(await screen.findByTestId('app')).toBeDefined()
    expect(bootApp).toHaveBeenCalledTimes(1)
    for (const [{ consent }] of initConsentedTelemetryMock.mock.calls) {
      expect(consent).toMatchObject({ crashReports: false, performance: false })
    }
  })

  it('should never let the shared VITE_SENTRY_DSN stand in for the owner UI’s own', async () => {
    // Arrange — the Tauri entry's variable set, the web entry's not
    vi.stubEnv('VITE_SENTRY_DSN_WILDFLOWER_REACT', '')
    vi.stubEnv('VITE_SENTRY_DSN', 'https://shared@sentry.example/1')
    storeConsent({ crashReports: true, performance: true })

    // Act
    await renderRoot(vi.fn(bootsTo(<div data-testid="app" />)))

    // Assert
    expect(await screen.findByTestId('app')).toBeDefined()
    expect(initConsentedTelemetryMock.mock.calls[0][0].config.sentry.dsn).toBe('')
  })

  it('should reopen the dialog from the settings row, and hand telemetry a changed answer without booting again', async () => {
    // Arrange — the booted app shows the Telemetry settings row
    storeConsent({ crashReports: false, performance: false })
    const bootApp = vi.fn(bootsTo(<TelemetrySettingsRows />))
    await renderRoot(bootApp)
    const row = await screen.findByRole('button', { name: SETTINGS_ROW_NAME })
    initConsentedTelemetryMock.mockClear()

    // Act
    fireEvent.click(row)
    expect(openDialog()).not.toBeNull()
    await answerDialogAndSettle({ crashReports: true, performance: false })

    // Assert — the new answer reaches telemetry; the app stays mounted
    await waitFor(() => {
      expect(initConsentedTelemetryMock).toHaveBeenCalled()
    })
    for (const [{ consent }] of initConsentedTelemetryMock.mock.calls) {
      expect(consent).toMatchObject({ crashReports: true, performance: false })
    }
    expect(bootApp).toHaveBeenCalledTimes(1)
    expect(openDialog()).toBeNull()
    expect(
      screen.getByRole('button', {
        name: settingsRowReading(
          `${TELEMETRY_CONSENT_COPY.crashReports.label} on · ${TELEMETRY_CONSENT_COPY.performance.label} off`
        ),
      })
    ).toBeDefined()
  })

  it('should report a boot that fails, and show the fallback in place of the app', async () => {
    // Arrange
    vi.spyOn(console, 'error').mockImplementation(() => {})
    storeConsent({ crashReports: true, performance: false })
    const bootFailure = new Error('the sign-in store could not be read')

    // Act
    await renderRoot(() => Promise.reject(bootFailure))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeDefined()
    expect(captureExceptionMock).toHaveBeenCalledWith(bootFailure, expect.anything())
  })
})

// Helpers

/**
 * Render the root under StrictMode, as `main-web`'s `mountAtRoot` does,
 * letting a boot that starts settle.
 */
async function renderRoot(bootApp: () => Promise<ReactNode>): Promise<void> {
  await act(async () => {
    render(
      <StrictMode>
        <WebEntryRoot bootApp={bootApp} />
      </StrictMode>
    )
  })
}

/** Answers the dialog, letting the boot the answer starts settle. */
async function answerDialogAndSettle(switches: Parameters<typeof answerDialog>[0]): Promise<void> {
  await act(async () => {
    answerDialog(switches)
  })
}

/** A boot that resolves to `appTree`. */
function bootsTo(appTree: JSX.Element): () => Promise<ReactNode> {
  return () => Promise.resolve(appTree)
}

/** The settings screen's Telemetry row, as the booted owner UI renders it. */
function TelemetrySettingsRows(): JSX.Element {
  return <ItemList items={useTelemetrySettingsItems()} />
}
