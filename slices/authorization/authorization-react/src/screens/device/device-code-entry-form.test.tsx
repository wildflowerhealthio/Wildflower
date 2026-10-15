import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { DeviceCodeEntryForm } from './device-code-entry-form.tsx'
import { normalize } from './device-code.ts'

afterEach(() => {
  cleanup()
})

describe('normalize', () => {
  test('upper-cases and drops characters outside the RFC 8628 alphabet', () => {
    // Digits and excluded letters (vowels, ambiguous glyphs) fall away.
    expect(normalize('b1c2d3f4')).toBe('BCDF')
    expect(normalize('bcdf')).toBe('BCDF')
  })

  test('inserts the single separating hyphen once past four code characters', () => {
    expect(normalize('bcdfghjk')).toBe('BCDF-GHJK')
    expect(normalize('bcdf-ghjk')).toBe('BCDF-GHJK')
  })

  test('clamps to the eight-character user code, dropping the overflow', () => {
    expect(normalize('BCDFGHJKLMNP')).toBe('BCDF-GHJK')
  })
})

describe('DeviceCodeEntryForm', () => {
  test('keeps Continue disabled until a complete code is entered, then submits the normalized code', async () => {
    // Arrange
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<DeviceCodeEntryForm onSubmit={onSubmit} />)
    const continueButton = screen.getByRole('button', { name: 'Continue' })

    // Assert — incomplete input can't be submitted.
    expect(continueButton.hasAttribute('disabled')).toBe(true)

    // Act — type a full code (lower-case, to also prove normalization).
    await user.type(screen.getByLabelText('Code'), 'bcdfghjk')

    // Assert — now enabled, and clicking forwards the canonical code.
    expect(continueButton.hasAttribute('disabled')).toBe(false)
    await user.click(continueButton)
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('BCDF-GHJK')
  })

  test('submits on Enter when the code is valid', async () => {
    // Arrange
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<DeviceCodeEntryForm onSubmit={onSubmit} />)

    // Act — type a full code and press Enter in the field.
    await user.type(screen.getByLabelText('Code'), 'bcdfghjk{Enter}')

    // Assert
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('BCDF-GHJK')
  })

  test('does not submit on Enter while the code is incomplete', async () => {
    // Arrange
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<DeviceCodeEntryForm onSubmit={onSubmit} />)

    // Act
    await user.type(screen.getByLabelText('Code'), 'bcd{Enter}')

    // Assert
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('starts from a normalized initial code and still waits for the owner to submit it', async () => {
    // Arrange
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<DeviceCodeEntryForm onSubmit={onSubmit} initialCode="bcdf-ghjk" />)

    // Assert — pre-filled, but never submitted on its own (RFC 8628 §5.4).
    expect(screen.getByLabelText<HTMLInputElement>('Code').value).toBe('BCDF-GHJK')
    expect(onSubmit).not.toHaveBeenCalled()

    // Act
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    // Assert
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('BCDF-GHJK')
  })

  test('shows the error above Continue, and holds Continue while submitting', () => {
    // Arrange / Act
    render(
      <DeviceCodeEntryForm
        onSubmit={vi.fn()}
        initialCode="BCDF-GHJK"
        error="No such code."
        submitting
      />
    )

    // Assert
    const alert = screen.getByRole('alert')
    const continueButton = screen.getByRole('button', { name: 'Continue' })
    expect(alert.textContent).toContain('No such code.')
    expect(
      alert.compareDocumentPosition(continueButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(continueButton.hasAttribute('disabled')).toBe(true)
  })
})
