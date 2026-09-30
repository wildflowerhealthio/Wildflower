import { cleanup, render, screen, within } from '@testing-library/react'
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
    const link = screen.getByLabelText('Wildflower, home')
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

  it('should be wrapped in a header element for banner landmark', () => {
    // Arrange / Act
    render(<BrandBar />)

    // Assert
    const banner = screen.getByRole('banner')
    expect(banner).toBeDefined()
  })

  it('should render nothing after the link when given no trailing control', () => {
    // Arrange / Act
    render(<BrandBar />)

    // Assert — the link is the bar's only child
    const banner = screen.getByRole('banner')
    expect(banner.children).toHaveLength(1)
    expect(banner.firstElementChild).toBe(screen.getByRole('link', { name: 'Wildflower, home' }))
  })

  it('should render the trailing control in the bar, after the link and outside it', () => {
    // Arrange / Act
    render(<BrandBar trailing={<button type="button">Telemetry: off</button>} />)

    // Assert
    const banner = screen.getByRole('banner')
    const link = within(banner).getByRole('link', { name: 'Wildflower, home' })
    const control = within(banner).getByRole('button', { name: 'Telemetry: off' })
    expect(link.contains(control)).toBe(false)
    expect(link.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })
})
