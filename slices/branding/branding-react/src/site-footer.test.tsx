import { act, cleanup, render, screen } from '@testing-library/react'
import { fromApp, onMarketingSite, sectionUrl } from 'branding-core'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { SiteFooter } from './site-footer.tsx'

afterEach(() => {
  cleanup()
  history.replaceState(null, '', window.location.pathname)
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
    expect(appsLink.getAttribute('href')).toBe('#how')

    const serverDocsLink = screen.getByText('Server API docs')
    expect(serverDocsLink.getAttribute('href')).toBe(sectionUrl('serverDocs'))
  })

  it('should render product links with app-context hrefs', () => {
    // Arrange / Act
    render(<SiteFooter nav={fromApp} />)

    // Assert
    const appsLink = screen.getByText('The apps')
    expect(appsLink.getAttribute('href')).toBe('https://wildflowerhealth.io/#how')
  })

  it('should toggle the About blurb when hash changes to #about-the-company', () => {
    // Arrange — render first, blurb should be absent
    render(<SiteFooter nav={onMarketingSite} />)
    expect(screen.queryByText(/There is no company/)).toBeNull()

    // Act — set hash to about-the-company
    act(() => {
      window.location.hash = '#about-the-company'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    // Assert — blurb appears
    expect(screen.getByText(/There is no company/)).toBeDefined()

    // Act — change hash away
    act(() => {
      window.location.hash = '#how'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    // Assert — blurb disappears
    expect(screen.queryByText(/There is no company/)).toBeNull()
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
