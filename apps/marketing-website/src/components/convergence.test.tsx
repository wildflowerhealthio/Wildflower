import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { Convergence } from './convergence.tsx'

afterEach(() => {
  cleanup()
})

describe('Convergence', () => {
  it('should preselect "Health insights" and leave the other apps unpressed', () => {
    // Arrange / Act
    render(<Convergence />)

    // Assert
    expect(appButton('Health insights').getAttribute('aria-pressed')).toBe('true')
    expect(appButton('Refill reminder').getAttribute('aria-pressed')).toBe('false')
    expect(appButton('Scheduling assistant').getAttribute('aria-pressed')).toBe('false')
  })

  it('should move the pressed state to the app the user taps', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<Convergence />)

    // Act
    await user.click(appButton('Scheduling assistant'))

    // Assert
    expect(appButton('Scheduling assistant').getAttribute('aria-pressed')).toBe('true')
    expect(appButton('Health insights').getAttribute('aria-pressed')).toBe('false')
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

/** The connectable-app button whose accessible name contains `name`. */
function appButton(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(name) })
}
