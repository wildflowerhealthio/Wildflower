import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { Checkbox } from './checkbox.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const getCheckbox = (name: string): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('checkbox', { name })

describe('Checkbox', () => {
  it('reflects the controlled checked state on the input', () => {
    // Arrange
    // Act
    render(<Checkbox checked={true} onChange={vi.fn()} label="Accept" />)

    // Assert
    expect(getCheckbox('Accept').checked).toBe(true)
  })

  it('fires onChange with the new checked state when toggled by the user', async () => {
    // Arrange
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Checkbox checked={false} onChange={onChange} label="Accept" />)

    // Act
    await user.click(getCheckbox('Accept'))

    // Assert
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('does not fire onChange when disabled and the user clicks', async () => {
    // Arrange
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Checkbox checked={false} disabled={true} onChange={onChange} label="Accept" />)

    // Act
    await user.click(getCheckbox('Accept'))

    // Assert
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders without onChange when disabled (compile-time discrimination)', () => {
    // Arrange
    // Act
    render(<Checkbox checked={true} disabled={true} label="Read-only" />)

    // Assert
    expect(getCheckbox('Read-only').disabled).toBe(true)
  })
})
