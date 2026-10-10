import { act, fireEvent, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { TelemetryConsentDialog } from './telemetry-consent-dialog.tsx'
import {
  openDialog,
  restoreDialogModality,
  stubDialogModality,
} from './telemetry-consent.test-helpers.ts'

beforeEach(() => {
  stubDialogModality()
})

afterEach(() => {
  restoreDialogModality()
  document.body.innerHTML = ''
})

const crashReportsSwitch = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('switch', { name: TELEMETRY_CONSENT_COPY.crashReports.label })

const performanceSwitch = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('switch', { name: TELEMETRY_CONSENT_COPY.performance.label })

const continueButton = (): HTMLElement =>
  screen.getByRole('button', { name: TELEMETRY_CONSENT_COPY.continueLabel })

describe('TelemetryConsentDialog', () => {
  it('should show the warning, where reports go, both switches with what they send, the session note and the disclaimer', () => {
    // Arrange + Act
    render(
      <TelemetryConsentDialog open={true} copy={TELEMETRY_CONSENT_COPY} onContinue={vi.fn()} />
    )

    // Assert
    expect(screen.getByRole('heading', { name: TELEMETRY_CONSENT_COPY.title })).toBeDefined()
    for (const paragraph of TELEMETRY_CONSENT_COPY.warning) {
      expect(screen.getByText(paragraph)).toBeDefined()
    }
    expect(screen.getByText(TELEMETRY_CONSENT_COPY.destination)).toBeDefined()
    expect(screen.getByText(TELEMETRY_CONSENT_COPY.crashReports.description)).toBeDefined()
    expect(screen.getByText(TELEMETRY_CONSENT_COPY.performance.description)).toBeDefined()
    expect(screen.getByText(TELEMETRY_CONSENT_COPY.sessions)).toBeDefined()
    expect(screen.getByText(TELEMETRY_CONSENT_COPY.changeLater)).toBeDefined()
    expect(screen.getByText(TELEMETRY_CONSENT_COPY.asIs)).toBeDefined()
    expect(
      screen
        .getByRole('link', { name: TELEMETRY_CONSENT_COPY.sourceCode.linkLabel })
        .getAttribute('href')
    ).toBe(TELEMETRY_CONSENT_COPY.sourceCode.href)
  }, 15_000)

  it('should end on the acceptance sentence, linking the Terms of Use and the Privacy Policy', () => {
    // Arrange + Act
    render(
      <TelemetryConsentDialog open={true} copy={TELEMETRY_CONSENT_COPY} onContinue={vi.fn()} />
    )

    // Assert — the sentence reads whole, and each policy opens in its own tab
    // so the dialog, which can't be dismissed, stays where it is.
    const { acceptance } = TELEMETRY_CONSENT_COPY
    const termsLink = screen.getByRole('link', { name: acceptance.terms.label })
    expect(termsLink.closest('p')?.textContent).toBe(
      `${acceptance.before} ${acceptance.terms.label} ${acceptance.between} ${acceptance.privacyPolicy.label}.`
    )
    for (const policy of [acceptance.terms, acceptance.privacyPolicy]) {
      const link = screen.getByRole('link', { name: policy.label })
      expect(link.getAttribute('href')).toBe(policy.href)
      expect(link.getAttribute('target')).toBe('_blank')
    }
  })

  it('should be named by its title and describe each switch by what it sends', () => {
    // Arrange + Act
    render(
      <TelemetryConsentDialog open={true} copy={TELEMETRY_CONSENT_COPY} onContinue={vi.fn()} />
    )

    // Assert
    expect(screen.getByRole('dialog', { name: TELEMETRY_CONSENT_COPY.title })).toBeDefined()
    for (const [consentSwitch, switchCopy] of [
      [crashReportsSwitch(), TELEMETRY_CONSENT_COPY.crashReports],
      [performanceSwitch(), TELEMETRY_CONSENT_COPY.performance],
    ] as const) {
      const descriptionId = consentSwitch.getAttribute('aria-describedby')
      expect(
        descriptionId === null ? null : document.getElementById(descriptionId)?.textContent
      ).toBe(switchCopy.description)
    }
  })

  it('should start with both switches off and continue with both off', () => {
    // Arrange
    const onContinue = vi.fn()
    render(
      <TelemetryConsentDialog open={true} copy={TELEMETRY_CONSENT_COPY} onContinue={onContinue} />
    )

    // Act
    fireEvent.click(continueButton())

    // Assert
    expect(crashReportsSwitch().checked).toBe(false)
    expect(performanceSwitch().checked).toBe(false)
    expect(onContinue).toHaveBeenCalledWith({ crashReports: false, performance: false })
  })

  it('should start from the answer being changed, and continue with it untouched', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (crashReports, performance) => {
        // Arrange
        const onContinue = vi.fn()
        render(
          <TelemetryConsentDialog
            open={true}
            copy={TELEMETRY_CONSENT_COPY}
            initial={{ crashReports, performance }}
            onContinue={onContinue}
          />
        )

        // Act
        fireEvent.click(continueButton())

        // Assert
        expect(crashReportsSwitch().checked).toBe(crashReports)
        expect(performanceSwitch().checked).toBe(performance)
        expect(onContinue).toHaveBeenCalledWith({ crashReports, performance })
        document.body.innerHTML = ''
      }),
      { numRuns: numRunsFor({ base: 8 }) }
    )
  })

  it('should continue with the switches as the visitor set them', async () => {
    // Arrange
    const user = userEvent.setup()
    const onContinue = vi.fn()
    render(
      <TelemetryConsentDialog open={true} copy={TELEMETRY_CONSENT_COPY} onContinue={onContinue} />
    )

    // Act
    await user.click(performanceSwitch())
    await user.click(continueButton())

    // Assert
    expect(onContinue).toHaveBeenCalledWith({ crashReports: false, performance: true })
  })

  it('should offer no close button and stay open on Escape', () => {
    // Arrange
    render(
      <TelemetryConsentDialog open={true} copy={TELEMETRY_CONSENT_COPY} onContinue={vi.fn()} />
    )
    const dialog = openDialog()
    if (dialog === null) throw new Error('expected the dialog to be open')
    const escape = new Event('cancel', { bubbles: false, cancelable: true })

    // Act
    fireEvent(dialog, escape)

    // Assert
    expect(escape.defaultPrevented).toBe(true)
    expect(openDialog()).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it('should open again, keeping the switches as set, when the browser closes it before the visitor answers', () => {
    // Arrange
    const onContinue = vi.fn()
    render(
      <TelemetryConsentDialog open={true} copy={TELEMETRY_CONSENT_COPY} onContinue={onContinue} />
    )
    fireEvent.click(crashReportsSwitch())

    // Act: what Chrome does on a second Escape with no click in between.
    act(() => openDialog()?.close())

    // Assert
    expect(openDialog()).not.toBeNull()
    expect(crashReportsSwitch().checked).toBe(true)
    expect(onContinue).not.toHaveBeenCalled()
  })

  it('should stay closed when closed by its caller', () => {
    // Arrange
    const { rerender } = render(
      <TelemetryConsentDialog open={true} copy={TELEMETRY_CONSENT_COPY} onContinue={vi.fn()} />
    )

    // Act
    rerender(
      <TelemetryConsentDialog open={false} copy={TELEMETRY_CONSENT_COPY} onContinue={vi.fn()} />
    )

    // Assert
    expect(openDialog()).toBeNull()
  })
})
