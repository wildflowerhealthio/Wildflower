import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { SegmentedToggle } from './segmented-toggle.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

type View = 'medications' | 'interactions'

const twoOptions: readonly { value: View; label: string }[] = [
  { value: 'medications', label: 'Medications' },
  { value: 'interactions', label: 'Interactions' },
]

describe('SegmentedToggle', () => {
  it('marks exactly one button pressed, and it matches `value`', () => {
    render(
      <SegmentedToggle
        value="interactions"
        options={twoOptions}
        onChange={vi.fn()}
        aria-label="View"
      />
    )
    const pressed = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
    expect(pressed[0]?.textContent).toBe('Interactions')
    expect(screen.getByRole('button', { name: 'Medications' }).getAttribute('aria-pressed')).toBe(
      'false'
    )
  })

  it('calls onChange with the clicked option value', async () => {
    const onChange = vi.fn<(value: View) => void>()
    const user = userEvent.setup()
    render(
      <SegmentedToggle
        value="medications"
        options={twoOptions}
        onChange={onChange}
        aria-label="View"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Interactions' }))

    expect(onChange).toHaveBeenCalledExactlyOnceWith('interactions')
  })

  it('carries the accessible label on the group', () => {
    render(
      <SegmentedToggle
        value="medications"
        options={twoOptions}
        onChange={vi.fn()}
        aria-label="View"
      />
    )
    expect(screen.getByRole('group', { name: 'View' })).toBeDefined()
  })

  it('is keyboard-reachable — Tab focuses a button and Space activates it', async () => {
    const onChange = vi.fn<(value: View) => void>()
    const user = userEvent.setup()
    render(
      <SegmentedToggle
        value="medications"
        options={twoOptions}
        onChange={onChange}
        aria-label="View"
      />
    )

    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Medications' }))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Interactions' }))

    await user.keyboard(' ')

    expect(onChange).toHaveBeenCalledExactlyOnceWith('interactions')
  })
})
