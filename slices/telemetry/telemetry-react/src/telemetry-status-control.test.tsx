import { fireEvent, render, screen } from '@testing-library/react'
import { TELEMETRY_CONSENT_COPY } from 'branding-core'
import type { TelemetryConsent } from 'telemetry-core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { TelemetryStatusControl } from './telemetry-status-control.tsx'
import type { TelemetryConsentSwitches } from './use-telemetry-consent.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

const consentWith = (switches: TelemetryConsentSwitches): TelemetryConsent => ({
  version: 1,
  decidedAt: '2026-09-29T12:00:00.000Z',
  ...switches,
})

const { crashReports, performance } = TELEMETRY_CONSENT_COPY

describe('TelemetryStatusControl', () => {
  it.each([
    [{ crashReports: false, performance: false }, 'Telemetry: off'],
    [
      { crashReports: true, performance: false },
      `Telemetry: ${crashReports.label} on · ${performance.label} off`,
    ],
    [
      { crashReports: false, performance: true },
      `Telemetry: ${crashReports.label} off · ${performance.label} on`,
    ],
    [
      { crashReports: true, performance: true },
      `Telemetry: ${crashReports.label} on · ${performance.label} on`,
    ],
  ])('should read %o as "%s", and say pressing it changes the settings', (switches, status) => {
    // Arrange + Act
    render(
      <TelemetryStatusControl
        consent={consentWith(switches)}
        copy={TELEMETRY_CONSENT_COPY}
        onPress={vi.fn()}
      />
    )

    // Assert
    expect(
      screen.getByRole('button', { name: `${status}, change telemetry settings` })
    ).toBeDefined()
  })

  it('should call onPress when pressed', () => {
    // Arrange
    const onPress = vi.fn()
    render(
      <TelemetryStatusControl
        consent={consentWith({ crashReports: true, performance: false })}
        copy={TELEMETRY_CONSENT_COPY}
        onPress={onPress}
      />
    )

    // Act
    fireEvent.click(screen.getByRole('button', { name: /change telemetry settings/ }))

    // Assert
    expect(onPress).toHaveBeenCalledTimes(1)
  })
})
