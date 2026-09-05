import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { GateCard } from './gate-card.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('GateCard', () => {
  it('announces the title from a status region', () => {
    render(
      <GateCard
        title="Waiting for your full medication list"
        body="Interactions are checked against every medication at once."
      />
    )

    const card = screen.getByRole('status')
    expect(card.textContent).toContain('Waiting for your full medication list')
    expect(card.textContent).toContain('checked against every medication')
  })

  it('shows the spinner by default and hides it in the paused variant', () => {
    const spinning = render(<GateCard title="Loading" />)
    expect(spinning.container.querySelector('[aria-hidden="true"]')).not.toBeNull()
    spinning.unmount()

    const paused = render(<GateCard title="Paused" showSpinner={false} />)
    expect(paused.container.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  it('renders the action as a button and fires its handler', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <GateCard
        title="Only part of your list is loaded"
        showSpinner={false}
        action={{ label: 'Load the rest of my medications', onClick }}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Load the rest of my medications' }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('omits body and action when not provided', () => {
    render(<GateCard title="Loading" />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('status').querySelectorAll('p')).toHaveLength(1)
  })
})
