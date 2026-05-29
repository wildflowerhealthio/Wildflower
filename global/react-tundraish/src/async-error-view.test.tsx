import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { AsyncErrorView } from './async-error-view.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('AsyncErrorView', () => {
  it('renders the supplied error via PageError', () => {
    // Arrange + Act — AsyncErrorView now takes the error as a prop, so a
    // parent `<CatchBoundary>` (e.g. via the `Awaited` wrapper) feeds it
    // the thrown value. The test renders the leaf directly to assert the
    // rendering shape.
    render(<AsyncErrorView error={new Error('fetch failed')} title="Not Found" />)

    // Assert
    expect(screen.getByRole('heading', { name: 'Not Found' })).toBeTruthy()
    expect(screen.getByText('fetch failed')).toBeTruthy()
  })

  it('renders without a heading when no title prop is given', () => {
    // Arrange + Act
    render(<AsyncErrorView error="boom" />)

    // Assert
    expect(screen.getByText('boom')).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()
  })
})
