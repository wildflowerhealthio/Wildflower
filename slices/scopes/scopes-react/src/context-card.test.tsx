import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { ContextCard } from './context-card.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ContextCard', () => {
  it('renders as a radio reflecting its selected state', () => {
    render(
      <ContextCard label="Just this patient" code="patient/" selected={true} onSelect={vi.fn()} />
    )
    expect(
      screen.getByRole('radio', { name: /Just this patient/ }).getAttribute('aria-checked')
    ).toBe('true')
  }, 15_000)

  it('fires onSelect when chosen', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<ContextCard label="All patients" code="system/" selected={false} onSelect={onSelect} />)

    await user.click(screen.getByRole('radio', { name: /All patients/ }))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
