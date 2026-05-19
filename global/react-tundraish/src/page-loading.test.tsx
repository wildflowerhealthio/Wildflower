import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { PageLoading } from './page-loading.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('PageLoading', () => {
  it('renders the default "Loading…" copy when no message prop is given', () => {
    // Arrange
    // Act
    render(<PageLoading />)

    // Assert
    expect(screen.getByText('Loading…')).toBeTruthy()
  }, 15_000)

  it('renders the provided message when overridden', () => {
    // Arrange
    // Act
    render(<PageLoading message="Fetching consents…" />)

    // Assert
    expect(screen.getByText('Fetching consents…')).toBeTruthy()
  })
})
