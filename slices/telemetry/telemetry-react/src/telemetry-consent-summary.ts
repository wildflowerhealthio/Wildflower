import type { TelemetryConsentCopy } from '@wildflowerhealthio/branding-core'
import type { TelemetryConsent } from '@wildflowerhealthio/telemetry-core'

/** How a summary reads one switch. */
const onOff = (switchedOn: boolean): string => (switchedOn ? 'on' : 'off')

/**
 * Each switch of `consent` by its label with on or off, e.g. "Crash reports
 * on · Performance data off": the status control's reading, and the
 * launcher's Telemetry settings row's.
 */
const telemetryConsentSummary = (consent: TelemetryConsent, copy: TelemetryConsentCopy): string =>
  `${copy.crashReports.label} ${onOff(consent.crashReports)}` +
  ` · ${copy.performance.label} ${onOff(consent.performance)}`

export { telemetryConsentSummary }
