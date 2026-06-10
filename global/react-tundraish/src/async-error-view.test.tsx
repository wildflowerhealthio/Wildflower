import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { AsyncErrorView } from './async-error-view.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('AsyncErrorView', () => {
  it('renders the supplied error via PageBodyError', () => {
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

  it('renders multi-line messages in a <pre> with the lines preserved', () => {
    // Arrange — the shape Effect Schema ParseErrors take: a type header
    // followed by a box-drawing tree whose alignment depends on the
    // message's own whitespace surviving rendering.
    const message = [
      '(JsonString <-> ReadonlyArray<AppEntry>)',
      '└─ Encoded side transformation failure',
      '   └─ Transformation process failure',
      '      └─ Could not parse JSON',
    ].join('\n')

    // Act
    render(<AsyncErrorView error={new Error(message)} />)

    // Assert — a `<pre>` (monospace, `pre-wrap` via its module class)
    // carrying the message verbatim, newlines and indentation intact.
    const pre = document.querySelector('pre')
    expect(pre?.textContent).toBe(message)
  })

  it('keeps single-line messages in a <p>, not a <pre>', () => {
    // Arrange + Act
    render(<AsyncErrorView error={new Error('fetch failed')} />)

    // Assert
    expect(screen.getByText('fetch failed').tagName).toBe('P')
    expect(document.querySelector('pre')).toBeNull()
  })
})
