import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { RadioGroup } from './radio-group.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const options = [
  { value: 'a' as const, label: 'Apple' },
  { value: 'b' as const, label: 'Banana' },
  { value: 'c' as const, label: 'Cherry', disabled: true },
]

const getRadio = (name: string): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('radio', { name })

describe('RadioGroup', () => {
  // First-render React Testing Library setup (jsdom environment + render) can
  // exceed the 5s default under the CPU contention of `vp run -r test`. Bumped
  // for headroom; cheap once the renderer has warmed up for later tests.
  it('marks the input matching the value prop as checked', () => {
    // Arrange
    // Act
    render(<RadioGroup name="fruit" value="b" onChange={vi.fn()} options={options} />)

    // Assert
    expect(getRadio('Banana').checked).toBe(true)
    expect(getRadio('Apple').checked).toBe(false)
  }, 15_000)

  it('fires onChange with the value of the option the user selects', async () => {
    // Arrange
    const onChange = vi.fn<(v: 'a' | 'b' | 'c') => void>()
    const user = userEvent.setup()
    render(<RadioGroup name="fruit" value="a" onChange={onChange} options={options} />)

    // Act
    await user.click(getRadio('Banana'))

    // Assert
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('does not fire onChange when the user clicks a disabled option', async () => {
    // Arrange
    const onChange = vi.fn<(v: 'a' | 'b' | 'c') => void>()
    const user = userEvent.setup()
    render(<RadioGroup name="fruit" value="a" onChange={onChange} options={options} />)

    // Act
    await user.click(getRadio('Cherry'))

    // Assert
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders the legend in a <legend> element when provided', () => {
    // Arrange
    // Act
    render(
      <RadioGroup name="fruit" value="a" onChange={vi.fn()} options={options} legend="Pick one" />
    )

    // Assert
    const legend = screen.getByText('Pick one')
    expect(legend.tagName).toBe('LEGEND')
  })
})
