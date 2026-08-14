import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { BetaForm } from './beta-form.tsx'

afterEach(() => {
  cleanup()
})

describe('BetaForm', () => {
  it('should render a labelled email field and the hero submit button', () => {
    // Arrange / Act
    render(<BetaForm variant="hero" />)

    // Assert
    expect(screen.getByLabelText('Email address')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Request beta invite' })).not.toBeNull()
  })

  it('should swap the form for the hero success message after a valid submit', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<BetaForm variant="hero" />)

    // Act
    await user.type(screen.getByLabelText('Email address'), 'ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Request beta invite' }))

    // Assert
    expect(screen.getByRole('status').textContent).toContain(
      "You're on the list — we'll send your invite soon."
    )
    expect(screen.queryByLabelText('Email address')).toBeNull()
  })

  it('should show the CTA-specific copy and button label for the cta variant', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<BetaForm variant="cta" />)

    // Act
    await user.type(screen.getByLabelText('Email address'), 'grace@example.com')
    await user.click(screen.getByRole('button', { name: 'Request invite' }))

    // Assert
    expect(screen.getByRole('status').textContent).toContain('Thanks — your invite is on its way.')
  })

  it('should keep the form visible when an invalid email is submitted', async () => {
    // Arrange
    const user = userEvent.setup()
    render(<BetaForm variant="hero" />)

    // Act
    await user.type(screen.getByLabelText('Email address'), 'not-an-email')
    await user.click(screen.getByRole('button', { name: 'Request beta invite' }))

    // Assert
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByLabelText('Email address')).not.toBeNull()
  })
})
