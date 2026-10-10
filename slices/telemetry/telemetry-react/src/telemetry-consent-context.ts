import type { TelemetryConsentCopy } from '@wildflowerhealthio/branding-core'
import { useContextOrThrow } from '@wildflowerhealthio/react-kitchen-sink'
import type { TelemetryConsent } from '@wildflowerhealthio/telemetry-core'
import { createContext } from 'react'

/**
 * What a `TelemetryConsentGate` hands the app it reveals: the answer, the
 * words it was given to, and a way to change it.
 */
interface TelemetryConsentControls {
  /** The visitor's answer, always given by the time the app renders. */
  readonly consent: TelemetryConsent
  /** The gate's dialog copy, whose switch labels name the switches wherever the answer is read out. */
  readonly copy: TelemetryConsentCopy
  /** Show the consent dialog again, with the switches set to `consent`. */
  readonly reopen: () => void
}

/**
 * Holds the {@link TelemetryConsentControls} for the children of a
 * `TelemetryConsentGate`. Read with {@link useTelemetryConsentControls}.
 * `null` outside a gate.
 */
const TelemetryConsentContext = createContext<TelemetryConsentControls | null>(null)
TelemetryConsentContext.displayName = 'TelemetryConsentContext'

/**
 * The visitor's telemetry answer and the way to reopen the dialog, for app
 * chrome inside a `TelemetryConsentGate` (the status control in the brand bar
 * or above the footer). Throws outside a gate, where there is no answer to
 * show.
 */
const useTelemetryConsentControls = (): TelemetryConsentControls =>
  useContextOrThrow(TelemetryConsentContext)

export { TelemetryConsentContext, useTelemetryConsentControls }
export type { TelemetryConsentControls }
