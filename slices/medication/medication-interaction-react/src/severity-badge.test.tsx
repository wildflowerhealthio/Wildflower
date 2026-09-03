import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { SeverityBadge } from './severity-badge.tsx'

afterEach(cleanup)

describe('SeverityBadge', () => {
  it('should render the level label as a status badge', () => {
    render(<SeverityBadge severity="moderate" />)
    expect(screen.getByRole('status').textContent).toContain('Moderate')
  })

  it('should paint Major in the danger tone and Unknown in the neutral tone', () => {
    render(
      <>
        <SeverityBadge severity="major" />
        <SeverityBadge severity="unknown" />
      </>
    )
    const [major, unknown] = screen.getAllByRole('status')
    expect(major?.className).toContain('accent-red')
    expect(unknown?.className).not.toContain('accent-')
  })
})
