import { TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import type { TelemetryConsent } from '@wildflowerhealthio/telemetry-core'
import { describe, expect, it } from 'vite-plus/test'

import { telemetryConsentSummary } from './telemetry-consent-summary.ts'
import type { TelemetryConsentSwitches } from './use-telemetry-consent.ts'

const consentWith = (switches: TelemetryConsentSwitches): TelemetryConsent => ({
  version: 1,
  decidedAt: '2026-09-29T12:00:00.000Z',
  ...switches,
})

const { crashReports, performance } = TELEMETRY_CONSENT_COPY

describe('telemetryConsentSummary', () => {
  it.each([
    [
      { crashReports: false, performance: false },
      `${crashReports.label} off · ${performance.label} off`,
    ],
    [
      { crashReports: true, performance: false },
      `${crashReports.label} on · ${performance.label} off`,
    ],
    [
      { crashReports: false, performance: true },
      `${crashReports.label} off · ${performance.label} on`,
    ],
    [
      { crashReports: true, performance: true },
      `${crashReports.label} on · ${performance.label} on`,
    ],
  ])('should read %o as "%s"', (switches, summary) => {
    // Arrange + Act + Assert
    expect(telemetryConsentSummary(consentWith(switches), TELEMETRY_CONSENT_COPY)).toBe(summary)
  })
})
