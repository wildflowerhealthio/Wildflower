import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ErrorBodyRendererContext } from './error-body-renderer.ts'
import { PageBodyError } from './page-body-error.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('PageBodyError', () => {
  it('renders the title when provided', () => {
    // Arrange
    // Act
    render(<PageBodyError title="Something went wrong" error={new Error('boom')} />)

    // Assert
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy()
  }, 15_000)

  it('omits the heading entirely when title is undefined', () => {
    // Arrange
    // Act
    render(<PageBodyError error={new Error('boom')} />)

    // Assert
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('surfaces error.message when given an Error instance', () => {
    // Arrange
    // Act
    render(<PageBodyError error={new Error('network unreachable')} />)

    // Assert
    expect(screen.getByText('network unreachable')).toBeTruthy()
  })

  it('stringifies non-Error values via String()', () => {
    // Arrange
    // Act
    render(<PageBodyError error="raw string error" />)

    // Assert
    expect(screen.getByText('raw string error')).toBeTruthy()
  })

  it('merges the titleClassName prop onto the heading', () => {
    // Arrange
    // Act
    render(<PageBodyError title="T" error="oops" titleClassName="custom-title" />)

    // Assert
    expect(screen.getByRole('heading', { name: 'T' }).classList.contains('custom-title')).toBe(true)
  })

  it('renders a custom renderError body in place of the message + retry, keeping the title', () => {
    render(
      <PageBodyError
        title="Your data"
        error={new Error('boom')}
        retry={() => undefined}
        renderError={() => <div data-testid="custom">custom body</div>}
      />
    )

    expect(screen.getByRole('heading', { name: 'Your data' })).toBeTruthy()
    expect(screen.getByTestId('custom')).toBeTruthy()
    expect(screen.queryByText('boom')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('falls back to the default message when renderError returns null', () => {
    render(<PageBodyError error={new Error('fallback')} renderError={() => null} />)

    expect(screen.getByText('fallback')).toBeTruthy()
  })

  it('consults the ambient ErrorBodyRendererContext when no prop is given', () => {
    render(
      <ErrorBodyRendererContext.Provider value={() => <div data-testid="ambient">ambient</div>}>
        <PageBodyError error={new Error('boom')} />
      </ErrorBodyRendererContext.Provider>
    )

    expect(screen.getByTestId('ambient')).toBeTruthy()
    expect(screen.queryByText('boom')).toBeNull()
  })

  it('lets the renderError prop override the ambient context', () => {
    render(
      <ErrorBodyRendererContext.Provider value={() => <div>ambient</div>}>
        <PageBodyError
          error={new Error('boom')}
          renderError={() => <div data-testid="prop">prop</div>}
        />
      </ErrorBodyRendererContext.Provider>
    )

    expect(screen.getByTestId('prop')).toBeTruthy()
    expect(screen.queryByText('ambient')).toBeNull()
  })
})
