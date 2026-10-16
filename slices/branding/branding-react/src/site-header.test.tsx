import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  fromApp,
  onMarketingSiteAt,
  sectionHref,
  sectionUrl,
} from '@wildflowerhealthio/branding-core'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { SiteHeader } from './site-header.tsx'

/** A PR preview's homepage, whose section links stay inside the preview. */
const onMarketingSite = onMarketingSiteAt('https://wildflowerhealthio.github.io/staging/pr-7/')

afterEach(() => {
  cleanup()
})

describe('SiteHeader', () => {
  it('should render the id="top" anchor target', () => {
    // Arrange / Act
    const { container } = render(<SiteHeader nav={onMarketingSite} />)

    // Assert
    expect(container.querySelector('#top')).not.toBeNull()
  })

  it("should link directly into the six apps in the marketing page's copy of the site", () => {
    // Arrange / Act
    render(<SiteHeader nav={onMarketingSite} />)

    // Assert — a preview's homepage routes into the preview's own builds, not
    // the apps' published origins (see `sectionHref` in branding-core).
    const nav = screen.getByRole('navigation', { name: 'Apps' })
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
    expect(hrefs).toStrictEqual([
      sectionHref(onMarketingSite, 'medications'),
      sectionHref(onMarketingSite, 'plots'),
      sectionHref(onMarketingSite, 'strength'),
      sectionHref(onMarketingSite, 'importer'),
      sectionHref(onMarketingSite, 'serverDocs'),
      sectionHref(onMarketingSite, 'ohifViewer'),
    ])
    expect(hrefs[0]).toBe('https://wildflowerhealthio.github.io/staging/pr-7/medications/')
  })

  it('should link into the six apps with absolute hrefs from an app', () => {
    // Arrange / Act
    render(<SiteHeader nav={fromApp} />)

    // Assert — an app bundle on any origin points back at the canonical origin.
    const nav = screen.getByRole('navigation', { name: 'Apps' })
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
    expect(hrefs).toStrictEqual([
      sectionUrl('medications'),
      sectionUrl('plots'),
      sectionUrl('strength'),
      sectionUrl('importer'),
      sectionUrl('serverDocs'),
      sectionUrl('ohifViewer'),
    ])
  })

  it('should carry the Wildflower Health Project wordmark linking to #top on the marketing site', () => {
    // Arrange / Act
    render(<SiteHeader nav={onMarketingSite} />)

    // Assert
    const brandLink = screen.getByRole('link', { name: 'Wildflower, home' })
    expect(brandLink.textContent).toContain('Wildflower Health Project')
    expect(brandLink.getAttribute('href')).toBe('#top')
  })

  it('should link the brand to the marketing URL from an app', () => {
    // Arrange / Act
    render(<SiteHeader nav={fromApp} />)

    // Assert
    expect(screen.getByRole('link', { name: 'Wildflower, home' }).getAttribute('href')).toBe(
      sectionUrl('marketing')
    )
  })

  it('should wrap the brand in a div by default so the page keeps its own h1', () => {
    // Arrange / Act
    const { container } = render(<SiteHeader nav={onMarketingSite} />)

    // Assert
    expect(container.querySelector('h1')).toBeNull()
    expect(screen.getByRole('link', { name: 'Wildflower, home' }).parentElement?.tagName).toBe(
      'DIV'
    )
  })

  it('should wrap the brand in the component given by titleAs', () => {
    // Arrange / Act
    render(<SiteHeader nav={onMarketingSite} titleAs="h1" />)

    // Assert
    const heading = screen.getByRole('heading', { level: 1 })
    expect(within(heading).getByRole('link', { name: 'Wildflower, home' })).toBeDefined()
  })

  it('should toggle the collapsed nav dropdown open and closed', () => {
    // Arrange
    const { container } = render(<SiteHeader nav={onMarketingSite} />)
    const toggle = screen.getByRole('button', { name: 'Apps menu' })
    const menu = container.querySelector('#site-header-menu')

    // Assert — starts closed.
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(menu?.getAttribute('data-open')).toBe('false')

    // Act — open it.
    fireEvent.click(toggle)

    // Assert
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(menu?.getAttribute('data-open')).toBe('true')

    // Act — close it.
    fireEvent.click(toggle)

    // Assert
    expect(menu?.getAttribute('data-open')).toBe('false')
  })

  it('should close the open dropdown when a link is selected', () => {
    // Arrange
    const { container } = render(<SiteHeader nav={onMarketingSite} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apps menu' }))
    const menu = container.querySelector('#site-header-menu')
    expect(menu?.getAttribute('data-open')).toBe('true')

    // Act
    fireEvent.click(screen.getByRole('link', { name: 'Medications' }))

    // Assert
    expect(menu?.getAttribute('data-open')).toBe('false')
  })

  it('should close the open dropdown on Escape', () => {
    // Arrange
    const { container } = render(<SiteHeader nav={onMarketingSite} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apps menu' }))
    const menu = container.querySelector('#site-header-menu')
    expect(menu?.getAttribute('data-open')).toBe('true')

    // Act
    fireEvent.keyDown(document, { key: 'Escape' })

    // Assert
    expect(menu?.getAttribute('data-open')).toBe('false')
  })
})
