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
})
