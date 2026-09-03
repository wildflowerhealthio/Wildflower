import { cleanup, render, screen } from '@testing-library/react'
import { fromApp, onMarketingSite, sectionUrl } from 'branding-core'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { SiteHeader } from './site-header.tsx'

afterEach(() => {
  cleanup()
})

describe('SiteHeader', () => {
  it('should render the id="top" anchor target', () => {
    // Arrange / Act
    const { container } = render(<SiteHeader nav={onMarketingSite} />)

    // Assert
    const header = container.querySelector('#top')
    expect(header).not.toBeNull()
  })

  it('should render all nav links with context-resolved hrefs on marketing site', () => {
    // Arrange / Act
    render(<SiteHeader nav={onMarketingSite} />)

    // Assert
    const appsLink = screen.getByText('The apps')
    expect(appsLink.getAttribute('href')).toBe('#built')

    const developersLink = screen.getByText('For developers')
    expect(developersLink.getAttribute('href')).toBe('#developers')
  })

  it('should render all nav links with absolute hrefs from an app', () => {
    // Arrange / Act
    render(<SiteHeader nav={fromApp} />)

    // Assert
    expect(screen.getByText('The apps').getAttribute('href')).toBe(
      'https://wildflowerhealth.io/#built'
    )
    expect(screen.getByText('For developers').getAttribute('href')).toBe(
      'https://wildflowerhealth.io/#developers'
    )
  })

  it('should link the brand to #top on the marketing site', () => {
    // Arrange / Act
    render(<SiteHeader nav={onMarketingSite} />)

    // Assert
    const brandLink = screen.getByLabelText('Wildflower, home')
    expect(brandLink.getAttribute('href')).toBe('#top')
  })

  it('should link the brand to the marketing URL from an app', () => {
    // Arrange / Act
    render(<SiteHeader nav={fromApp} />)

    // Assert
    const brandLink = screen.getByLabelText('Wildflower, home')
    expect(brandLink.getAttribute('href')).toBe(sectionUrl('marketing'))
  })
})
