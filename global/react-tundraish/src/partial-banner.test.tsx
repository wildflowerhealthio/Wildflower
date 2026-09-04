import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { PartialBanner } from './partial-banner.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('PartialBanner', () => {
  it('renders its copy in a status region with a decorative dot', () => {
    render(<PartialBanner>Partial list — still loading.</PartialBanner>)

    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('Partial list — still loading.')
    expect(banner.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  it('renders the optional action inline and fires it', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <PartialBanner action={{ label: 'load them all?', onClick }}>
        This is showing your 40 most recent medications,
      </PartialBanner>
    )

    await user.click(screen.getByRole('button', { name: 'load them all?' }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders no button without an action', () => {
    render(<PartialBanner>Loading the rest…</PartialBanner>)

    expect(screen.queryByRole('button')).toBeNull()
  })
})
