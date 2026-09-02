import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

vi.mock('./app.tsx', () => ({
  App: () => <div data-testid="app-stub">App</div>,
}))

vi.mock('fhir-r4-react/connect', () => ({
  ConnectMenu: () => <div data-testid="connect-menu-stub">ConnectMenu</div>,
}))

import { AppRoot } from './app-root.tsx'

afterEach(() => {
  cleanup()
})

describe('AppRoot', () => {
  it('should render BrandBar and App when launched', () => {
    // Arrange / Act
    render(<AppRoot launched />)

    // Assert — the slim brand bar is a link with the Wildflower home aria-label
    const brandLink = screen.getByRole('link', { name: 'Wildflower, home' })
    expect(brandLink).toBeDefined()
    expect(brandLink.getAttribute('href')).toBe('https://wildflowerhealth.io/')

    // The app stub is mounted
    expect(screen.getByTestId('app-stub')).toBeDefined()

    // No full chrome or connect menu
    expect(screen.queryByTestId('connect-menu-stub')).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull()
  })

  it('should render SiteHeader, ConnectMenu, and SiteFooter when not launched', () => {
    // Arrange / Act
    render(<AppRoot launched={false} />)

    // Assert — SiteHeader is present with id="top"
    expect(document.getElementById('top')).not.toBeNull()

    // The header's brand link points to the marketing site (absolute, not fragment)
    const headerBrand = screen.getAllByRole('link', { name: 'Wildflower, home' })
    expect(headerBrand.length).toBeGreaterThanOrEqual(1)
    const firstBrandLink = headerBrand[0]
    expect(firstBrandLink?.getAttribute('href')).toBe('https://wildflowerhealth.io/')

    // Primary nav links resolve as absolute hrefs
    const primaryNav = screen.getByRole('navigation', { name: 'Primary' })
    expect(primaryNav).toBeDefined()
    const howLink = within(primaryNav).getByRole('link', { name: 'The apps' })
    expect(howLink.getAttribute('href')).toBe('https://wildflowerhealth.io/#how')

    // ConnectMenu is present
    expect(screen.getByTestId('connect-menu-stub')).toBeDefined()

    // SiteFooter is present — the copyright line is a reliable anchor
    expect(screen.getByText(/© 2026 Wildflower Health/)).toBeDefined()

    // No App in the standalone branch
    expect(screen.queryByTestId('app-stub')).toBeNull()
  })
})
