import { fireEvent, render, screen } from '@testing-library/react'
import { TELEMETRY_CONSENT_COPY } from 'branding-core'
import { useEffect, type JSX } from 'react'
import { readConsent, type TelemetryConsent, writeConsent } from 'telemetry-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { useTelemetryConsentControls } from './telemetry-consent-context.ts'
import { TelemetryConsentGate } from './telemetry-consent-gate.tsx'
import {
  mapConsentStorage,
  openDialog,
  restoreDialogModality,
  stubDialogModality,
} from './telemetry-consent.test-helpers.ts'
import { TelemetryStatusControl } from './telemetry-status-control.tsx'

const NOW = new Date('2026-09-29T12:00:00.000Z')

beforeEach(() => {
  stubDialogModality()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  restoreDialogModality()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

type ConsentSwitches = Pick<TelemetryConsent, 'crashReports' | 'performance'>

const APP_TEXT = 'The app'

/** Stands in for the app: records that it mounted, and carries the status control. */
const App = ({ onMount }: { readonly onMount: () => void }): JSX.Element => {
  const { consent, reopen } = useTelemetryConsentControls()
  useEffect(onMount, [onMount])
  return (
    <main>
      <p>{APP_TEXT}</p>
      <TelemetryStatusControl consent={consent} copy={TELEMETRY_CONSENT_COPY} onChange={reopen} />
    </main>
  )
}

interface RenderedGate {
  readonly onDecided: ReturnType<typeof vi.fn<(consent: TelemetryConsent) => void>>
  readonly onAppMount: ReturnType<typeof vi.fn<() => void>>
}

const renderGate = (storage = mapConsentStorage()): RenderedGate => {
  const onDecided = vi.fn<(consent: TelemetryConsent) => void>()
  const onAppMount = vi.fn<() => void>()
  render(
    <TelemetryConsentGate storage={storage} copy={TELEMETRY_CONSENT_COPY} onDecided={onDecided}>
      <App onMount={onAppMount} />
    </TelemetryConsentGate>
  )
  return { onDecided, onAppMount }
}

const switchNamed = (label: string): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('switch', { name: label })

const setSwitches = ({ crashReports, performance }: ConsentSwitches): void => {
  for (const [label, wanted] of [
    [TELEMETRY_CONSENT_COPY.crashReports.label, crashReports],
    [TELEMETRY_CONSENT_COPY.performance.label, performance],
  ] as const) {
    if (switchNamed(label).checked !== wanted) fireEvent.click(switchNamed(label))
  }
}

const pressContinue = (): void => {
  fireEvent.click(screen.getByRole('button', { name: TELEMETRY_CONSENT_COPY.continueLabel }))
}

const answered = (switches: ConsentSwitches): TelemetryConsent => ({
  version: TELEMETRY_CONSENT_COPY.version,
  decidedAt: NOW.toISOString(),
  ...switches,
})

describe('TelemetryConsentGate', () => {
  it('should show only the dialog, and never mount the app, until the visitor answers', () => {
    // Arrange + Act
    const { onDecided, onAppMount } = renderGate()

    // Assert
    expect(openDialog()).not.toBeNull()
    expect(screen.queryByText(APP_TEXT)).toBeNull()
    expect(onAppMount).not.toHaveBeenCalled()
    expect(onDecided).not.toHaveBeenCalled()
  }, 15_000)

  it.each([
    { crashReports: false, performance: false },
    { crashReports: true, performance: false },
    { crashReports: false, performance: true },
    { crashReports: true, performance: true },
  ])('should keep the answer %o, report it, and reveal the app on Continue', (switches) => {
    // Arrange
    const storage = mapConsentStorage()
    const { onDecided, onAppMount } = renderGate(storage)

    // Act
    setSwitches(switches)
    pressContinue()

    // Assert
    expect(readConsent(storage, TELEMETRY_CONSENT_COPY.version)).toStrictEqual(answered(switches))
    expect(onDecided).toHaveBeenCalledTimes(1)
    expect(onDecided).toHaveBeenCalledWith(answered(switches))
    expect(openDialog()).toBeNull()
    expect(screen.getByText(APP_TEXT)).toBeDefined()
    expect(onAppMount).toHaveBeenCalledTimes(1)
  })

  it('should ask again, keeping the app unmounted, when the stored answer is for older copy', () => {
    // Arrange
    const storage = mapConsentStorage()
    writeConsent(storage, {
      ...answered({ crashReports: true, performance: true }),
      version: TELEMETRY_CONSENT_COPY.version - 1,
    })

    // Act
    const { onDecided, onAppMount } = renderGate(storage)

    // Assert
    expect(openDialog()).not.toBeNull()
    expect(onAppMount).not.toHaveBeenCalled()
    expect(onDecided).not.toHaveBeenCalled()
  })

  it('should skip the dialog and report a current stored answer on mount', () => {
    // Arrange
    const storage = mapConsentStorage()
    const stored = answered({ crashReports: true, performance: false })
    writeConsent(storage, stored)

    // Act
    const { onDecided, onAppMount } = renderGate(storage)

    // Assert
    expect(openDialog()).toBeNull()
    expect(screen.getByText(APP_TEXT)).toBeDefined()
    expect(onAppMount).toHaveBeenCalledTimes(1)
    expect(onDecided).toHaveBeenCalledTimes(1)
    expect(onDecided).toHaveBeenCalledWith(stored)
  })

  it('should reopen from the status control with the switches set to the answer, over the mounted app', () => {
    // Arrange
    const storage = mapConsentStorage()
    writeConsent(storage, answered({ crashReports: true, performance: false }))
    const { onDecided, onAppMount } = renderGate(storage)

    // Act
    fireEvent.click(screen.getByRole('button', { name: /change telemetry settings/ }))

    // Assert
    expect(openDialog()).not.toBeNull()
    expect(switchNamed(TELEMETRY_CONSENT_COPY.crashReports.label).checked).toBe(true)
    expect(switchNamed(TELEMETRY_CONSENT_COPY.performance.label).checked).toBe(false)
    expect(screen.getByText(APP_TEXT)).toBeDefined()

    // Act
    setSwitches({ crashReports: false, performance: true })
    pressContinue()

    // Assert
    const changed = answered({ crashReports: false, performance: true })
    expect(openDialog()).toBeNull()
    expect(readConsent(storage, TELEMETRY_CONSENT_COPY.version)).toStrictEqual(changed)
    expect(onDecided).toHaveBeenLastCalledWith(changed)
    expect(onAppMount).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', {
        name: `Telemetry: ${TELEMETRY_CONSENT_COPY.crashReports.label} off · ${TELEMETRY_CONSENT_COPY.performance.label} on, change telemetry settings`,
      })
    ).toBeDefined()
  })

  it('should keep the app unmounted when Escape is pressed on the undecided dialog', () => {
    // Arrange
    const { onAppMount } = renderGate()
    const dialog = openDialog()
    if (dialog === null) throw new Error('expected the dialog to be open')

    // Act
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }))

    // Assert
    expect(openDialog()).not.toBeNull()
    expect(onAppMount).not.toHaveBeenCalled()
  })
})
