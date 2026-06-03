import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { PageError } from './page-error.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('PageError', () => {
  it('renders the title when provided', () => {
    // Arrange
    // Act
    render(<PageError title="Something went wrong" error={new Error('boom')} />)

    // Assert
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy()
  }, 15_000)

  it('omits the heading entirely when title is undefined', () => {
    // Arrange
    // Act
    render(<PageError error={new Error('boom')} />)

    // Assert
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('surfaces error.message when given an Error instance', () => {
    // Arrange
    // Act
    render(<PageError error={new Error('network unreachable')} />)

    // Assert
    expect(screen.getByText('network unreachable')).toBeTruthy()
  })

  it('stringifies non-Error values via String()', () => {
    // Arrange
    // Act
    render(<PageError error="raw string error" />)

    // Assert
    expect(screen.getByText('raw string error')).toBeTruthy()
  })

  it('merges the titleClassName prop onto the heading', () => {
    // Arrange
    // Act
    render(<PageError title="T" error="oops" titleClassName="custom-title" />)

    // Assert
    expect(screen.getByRole('heading', { name: 'T' }).classList.contains('custom-title')).toBe(true)
  })
})
