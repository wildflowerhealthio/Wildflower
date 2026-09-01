import { cleanup, render, screen } from '@testing-library/react'
import { sectionUrl } from 'branding-core'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { BrandBar } from './brand-bar.tsx'

afterEach(() => {
  cleanup()
})

describe('BrandBar', () => {
  it('should link to the marketing site', () => {
    // Arrange / Act
    render(<BrandBar />)

    // Assert
    const link = screen.getByLabelText('Wildflower home')
    expect(link.getAttribute('href')).toBe(sectionUrl('marketing'))
  })

  it('should render the icon with an empty alt for decorative use', () => {
    // Arrange / Act
    const { container } = render(<BrandBar />)

    // Assert
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('alt')).toBe('')
  })

  it('should render the Wildflower wordmark', () => {
    // Arrange / Act
    render(<BrandBar />)

    // Assert
    expect(screen.getByText('Wildflower')).toBeDefined()
  })
})
