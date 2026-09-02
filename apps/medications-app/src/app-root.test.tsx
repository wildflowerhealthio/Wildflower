import { QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

// Stub the two leaf components that `AppRoot` branches between: the SMART app
// and the standalone connect menu. The branding chrome (`BrandBar`, `SiteHeader`,
// `SiteFooter`) renders for real so we can assert on its DOM output.
vi.mock('./app.tsx', () => ({
  App: () => <div data-testid="app" />,
}))
vi.mock('fhir-r4-react/connect', () => ({
  ConnectMenu: () => <div data-testid="connect-menu" />,
}))
vi.mock('fhir-r4-react/smart', () => ({
  buildSmartQueryClient: () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  shouldCompleteSmartLaunch: () => false,
}))

const { AppRoot } = await import('./app-root.tsx')

afterEach(() => {
  cleanup()
})

describe('AppRoot', () => {
  it('should render BrandBar and App when launched', () => {
    // Arrange / Act
    render(
      <StrictMode>
        <AppRoot launched />
      </StrictMode>
    )

    // Assert — the brand bar is a link back to the marketing site
    const brandLink = screen.getByLabelText('Wildflower, home')
    expect(brandLink.tagName).toBe('A')
    expect(brandLink.getAttribute('href')).toBe('https://wildflowerhealth.io/')

    // The SMART app renders, not the connect menu
    expect(screen.getByTestId('app')).toBeDefined()
    expect(screen.queryByTestId('connect-menu')).toBeNull()

    // No full site header or footer in the launched branch
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull()
  })

  it('should render SiteHeader, ConnectMenu, and SiteFooter when not launched', () => {
    // Arrange / Act
    render(
      <StrictMode>
        <AppRoot launched={false} />
      </StrictMode>
    )

    // Assert — full site header with #top anchor
    expect(document.getElementById('top')).not.toBeNull()

    // The connect menu renders, not the SMART app
    expect(screen.getByTestId('connect-menu')).toBeDefined()
    expect(screen.queryByTestId('app')).toBeNull()

    // SiteFooter is present (it renders a <footer>)
    const footers = document.querySelectorAll('footer')
    expect(footers.length).toBeGreaterThan(0)
  })

  it('should resolve nav hrefs as absolute URLs from an app', () => {
    // Arrange / Act
    render(
      <StrictMode>
        <AppRoot launched={false} />
      </StrictMode>
    )

    // Assert — the header's brand link points to the full marketing URL
    const brandLink = screen.getByLabelText('Wildflower, home')
    expect(brandLink.getAttribute('href')).toBe('https://wildflowerhealth.io/')

    // Anchor nav links in the header resolve to absolute hrefs
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    const links = nav.querySelectorAll('a')
    const hrefs = Array.from(links, (a) => a.getAttribute('href'))
    for (const href of hrefs) {
      expect(href).toMatch(/^https:\/\/wildflowerhealth\.io\//)
    }
  })
})
