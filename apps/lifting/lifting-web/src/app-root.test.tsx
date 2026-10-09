import { cleanup, render, screen } from '@testing-library/react'
import { APP_DESCRIPTIONS, TELEMETRY_CONSENT_COPY } from 'branding-core'
import { writeConsent } from 'telemetry-core'
import type * as TelemetryWeb from 'telemetry-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { AppRoot } from './app-root.tsx'

// The build variable this app's DSN comes from, set before `config.ts` reads it.
const { SENTRY_DSN } = vi.hoisted(() => {
  const dsn = 'https://key@sentry.example/7'
  vi.stubEnv('VITE_SENTRY_DSN_LIFTING_APP', dsn)
  return { SENTRY_DSN: dsn }
})

// Starting telemetry is stubbed at the module boundary, so the test reads back
// which project and tags the root hands it.
const { initConsentedTelemetryMock } = vi.hoisted(() => ({
  initConsentedTelemetryMock: vi.fn<typeof TelemetryWeb.initConsentedTelemetry>(() => false),
}))
vi.mock('telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  initConsentedTelemetry: initConsentedTelemetryMock,
}))

// The shell's own behaviour (the two branches, the latch, the shared client,
// the launch-failure banner) is covered by `smart-app-react`'s
// `smart-app-root.test.tsx`, the consent gate included; this pins only that the
// app mounts it as itself, reporting to its own Sentry project.
vi.mock('./app.tsx', () => ({
  App: () => <div data-testid="app" />,
}))

beforeEach(() => {
  // A returning visitor's answer, so the page is past the consent dialog.
  writeConsent(window.localStorage, {
    version: TELEMETRY_CONSENT_COPY.version,
    crashReports: true,
    performance: false,
    decidedAt: '2026-09-29T12:00:00.000Z',
  })
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  initConsentedTelemetryMock.mockClear()
})

describe('AppRoot', () => {
  it('should mount the shell as the lifting app when not launched', () => {
    // Arrange / Act
    render(<AppRoot launched={false} />)

    // Assert — the landing introduces this app, not another
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      APP_DESCRIPTIONS.lifting.name
    )
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('should start telemetry with this app’s own DSN and name', () => {
    // Arrange / Act
    render(<AppRoot launched={false} />)

    // Assert
    expect(initConsentedTelemetryMock).toHaveBeenCalledTimes(1)
    const [{ config, tags }] = initConsentedTelemetryMock.mock.calls[0]
    expect(config.sentry.dsn).toBe(SENTRY_DSN)
    expect(tags.app).toBe('lifting-app')
  })
})
