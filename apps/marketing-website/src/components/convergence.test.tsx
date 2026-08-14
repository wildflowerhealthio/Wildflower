import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { Convergence } from './convergence.tsx'

afterEach(() => {
  cleanup()
})

describe('Convergence', () => {
  it('should preselect the Medications app and leave the other apps unpressed', () => {
    // Arrange / Act
    render(<Convergence />)

    // Assert
    expect(appButton('Medications').getAttribute('aria-pressed')).toBe('true')
    expect(appButton('Web Trace').getAttribute('aria-pressed')).toBe('false')
    expect(appButton('Visits').getAttribute('aria-pressed')).toBe('false')
  })

  it('should link the published Medications app at its path on this domain', () => {
    // Arrange / Act — Medications is the default selection, so its link shows first.
    render(<Convergence />)

    // Assert
    expect(screen.getByRole('link', { name: 'Open Medications' }).getAttribute('href')).toBe(
      '/medications-app'
    )
  })

  it('should move the pressed state to the app the user taps', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<Convergence />)

    // Act
    await user.click(appButton('Visits'))

    // Assert
    expect(appButton('Visits').getAttribute('aria-pressed')).toBe('true')
    expect(appButton('Medications').getAttribute('aria-pressed')).toBe('false')
  })

  it('should drop the app link when the selected app is not published on this domain', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<Convergence />)

    // Act — Web Trace ships inside the Wildflower app, not at a URL here.
    await user.click(appButton('Web Trace'))

    // Assert
    expect(screen.queryByRole('link', { name: /^Open / })).toBeNull()
    expect(screen.getByText('In the Wildflower app')).not.toBeNull()
  })

  it('should list every standardized source', () => {
    // Arrange / Act
    render(<Convergence />)

    // Assert
    expect(screen.getByText('Rexall')).not.toBeNull()
    expect(screen.getByText('Shoppers Drug Mart')).not.toBeNull()
    expect(screen.getByText("Dr. Okafor's office")).not.toBeNull()
    expect(screen.getByText('LifeLabs')).not.toBeNull()
  })
})

// Helpers

/** The app selector button whose accessible name contains `name`. */
function appButton(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(name) })
}
