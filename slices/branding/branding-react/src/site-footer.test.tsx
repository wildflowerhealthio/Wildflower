import { cleanup, render, screen } from '@testing-library/react'
import { fromApp, onMarketingSite, sectionUrl } from 'branding-core'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { SiteFooter } from './site-footer.tsx'

afterEach(() => {
  cleanup()
})

describe('SiteFooter', () => {
  it('should render Product and Company column headings', () => {
    // Arrange / Act
    render(<SiteFooter nav={onMarketingSite} />)

    // Assert
    expect(screen.getByText('Product')).toBeDefined()
    expect(screen.getByText('Company')).toBeDefined()
  })

  it('should render product links with marketing-context hrefs', () => {
    // Arrange / Act
    render(<SiteFooter nav={onMarketingSite} />)

    // Assert
    const appsLink = screen.getByText('The apps')
    expect(appsLink.getAttribute('href')).toBe('#built')

    const serverDocsLink = screen.getByText('Server API docs')
    expect(serverDocsLink.getAttribute('href')).toBe(sectionUrl('serverDocs'))
  })

  it('should render product links with app-context hrefs', () => {
    // Arrange / Act
    render(<SiteFooter nav={fromApp} />)

    // Assert
    const appsLink = screen.getByText('The apps')
    expect(appsLink.getAttribute('href')).toBe('https://wildflowerhealth.io/#built')
  })

  it('should link About to the homepage footer note', () => {
    // Arrange / Act
    render(<SiteFooter nav={onMarketingSite} />)

    // Assert — the redesigned homepage carries the "not a company" copy in
    // its footer (`#note`); the old hash-gated blurb is gone.
    expect(screen.getByText('About').getAttribute('href')).toBe('#note')
  })

  it('should render company links including About and Contact', () => {
    // Arrange / Act
    render(<SiteFooter nav={onMarketingSite} />)

    // Assert
    expect(screen.getByText('About')).toBeDefined()
    expect(screen.getByText('Contact')).toBeDefined()

    const contactLink = screen.getByText('Contact')
    expect(contactLink.getAttribute('href')).toMatch(/^mailto:/)
  })

  it('should render the brand blurb and copyright', () => {
    // Arrange / Act
    render(<SiteFooter nav={onMarketingSite} />)

    // Assert
    expect(screen.getByText(/personal health record/)).toBeDefined()
    expect(screen.getByText(/© 2026 Wildflower Health/)).toBeDefined()
  })
})
