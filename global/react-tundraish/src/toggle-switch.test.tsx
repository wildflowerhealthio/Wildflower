import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ToggleSwitch } from './toggle-switch.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const getSwitch = (name: string): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('switch', { name })

describe('ToggleSwitch', () => {
  // First-render React Testing Library setup (jsdom environment + render) can
  // exceed the 5s default under the CPU contention of `vp run -r test`. Bumped
  // for headroom; cheap once the renderer has warmed up for later tests.
  it('renders the native checkbox under the "switch" role with controlled state', () => {
    render(<ToggleSwitch checked={true} onChange={vi.fn()} label="Run tunnel" />)

    expect(getSwitch('Run tunnel').checked).toBe(true)
  }, 15_000)

  it('fires onChange with the new checked state when the user clicks the row', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ToggleSwitch checked={false} onChange={onChange} label="Run tunnel" />)

    await user.click(getSwitch('Run tunnel'))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  // Keyboard activation is the assistive-tech path — the row is a `<label>`
  // wrapping a native checkbox-with-switch-role, so Tab + Space must flip it
  // without any custom keyboard handler.
  it('flips when the user activates the focused switch with the keyboard', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ToggleSwitch checked={false} onChange={onChange} label="Run tunnel" />)

    await user.tab()
    await user.keyboard(' ')

    expect(getSwitch('Run tunnel')).toBe(document.activeElement)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('does not fire onChange when disabled and the user clicks', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<ToggleSwitch checked={false} disabled={true} onChange={onChange} label="Run tunnel" />)

    await user.click(getSwitch('Run tunnel'))

    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders without onChange when disabled (compile-time discrimination)', () => {
    render(<ToggleSwitch checked={true} disabled={true} label="Read-only" />)

    expect(getSwitch('Read-only').disabled).toBe(true)
  })
})
