import { cleanup, render, screen, within } from '@testing-library/react'
import { APP_DESCRIPTIONS } from 'branding-core'
import type { ConnectMenuProps } from 'fhir-r4-react/connect'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

vi.mock('./app.tsx', () => ({
  App: () => <div data-testid="app-stub">App</div>,
}))

// The stub echoes the props it was handed as data attributes so the wiring
// (`clientId` / `scope` from config, `redirectUri` from the URL) is observable.
vi.mock('fhir-r4-react/connect', () => ({
  ConnectMenu: ({ clientId, scope, redirectUri }: ConnectMenuProps) => (
    <div
      data-testid="connect-menu-stub"
      data-client-id={clientId}
      data-scope={scope}
      data-redirect-uri={redirectUri}
    >
      ConnectMenu
    </div>
  ),
}))

import { AppRoot } from './app-root.tsx'
import { standaloneSmartConfig } from './config.ts'

/** Points jsdom's location at `search` (a `?…` string, or `''` for the bare root). */
const setSearch = (search: string): void => {
  window.history.replaceState({}, '', `/${search}`)
}

afterEach(() => {
  cleanup()
  setSearch('')
})

describe('AppRoot', () => {
  it('should render BrandBar and App when launched', () => {
    // Arrange / Act
    render(<AppRoot launched />)

    // Assert — the slim brand bar is a link with the Wildflower home aria-label
    const brandLink = screen.getByRole('link', { name: 'Wildflower, home' })
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
    const brandLink = screen.getByRole('link', { name: 'Wildflower, home' })
    expect(brandLink.getAttribute('href')).toBe('https://wildflowerhealth.io/')

    // Primary nav links resolve as absolute hrefs
    const primaryNav = screen.getByRole('navigation', { name: 'Primary' })
    const appsLink = within(primaryNav).getByRole('link', { name: 'The apps' })
    expect(appsLink.getAttribute('href')).toBe('https://wildflowerhealth.io/#built')

    // ConnectMenu is present, inside the page's main landmark
    expect(within(screen.getByRole('main')).getByTestId('connect-menu-stub')).toBeDefined()

    // SiteFooter is present — the copyright line is a reliable anchor
    expect(screen.getByText(/© 2026 Wildflower Health/)).toBeDefined()

    // No App in the standalone branch
    expect(screen.queryByTestId('app-stub')).toBeNull()
  })

  it('should introduce the Importer beside the connect menu when not launched', () => {
    // Arrange / Act
    render(<AppRoot launched={false} />)

    // Assert — the app name is the page's only h1 (the site header's brand is a div)
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0].textContent).toBe(APP_DESCRIPTIONS.importer.name)

    // The homepage's copy and a link to its section sit in the same main region
    const main = within(screen.getByRole('main'))
    expect(main.getByText(APP_DESCRIPTIONS.importer.paragraphs[0])).toBeDefined()
    expect(main.getByRole('link', { name: /Read the whole story/ }).getAttribute('href')).toBe(
      'https://wildflowerhealth.io/#try'
    )
  })

  it('should hand ConnectMenu the standalone client config and this root as its redirect', () => {
    // Arrange — served from a subpath, with a query that must not leak into the redirect
    window.history.replaceState({}, '', '/importer-app/index.html?utm_source=email')

    // Act
    render(<AppRoot launched={false} />)

    // Assert
    const menu = screen.getByTestId('connect-menu-stub')
    expect(menu.getAttribute('data-client-id')).toBe(standaloneSmartConfig.clientId)
    expect(menu.getAttribute('data-scope')).toBe(standaloneSmartConfig.scope)
    expect(menu.getAttribute('data-redirect-uri')).toBe(`${window.location.origin}/importer-app/`)
  })

  describe('with no `launched` prop, the URL decides', () => {
    it.each([
      { search: '?code=abc&state=xyz', expectApp: true },
      { search: '?state=xyz', expectApp: true },
      { search: '', expectApp: false },
      { search: '?utm_source=email', expectApp: false },
      { search: '?error=access_denied&state=xyz', expectApp: false },
    ])('should render App=$expectApp for "$search"', ({ search, expectApp }) => {
      // Arrange
      setSearch(search)

      // Act
      render(<AppRoot />)

      // Assert — exactly one of the two branches is mounted
      expect(screen.queryByTestId('app-stub') !== null).toBe(expectApp)
      expect(screen.queryByTestId('connect-menu-stub') !== null).toBe(!expectApp)
    })

    it('should keep App mounted after the callback params leave the URL', () => {
      // Arrange — a launch in progress
      setSearch('?code=abc&state=xyz')
      const { rerender } = render(<AppRoot />)
      expect(screen.getByTestId('app-stub')).toBeDefined()

      // Act — fhirclient's `oauth2.ready()` strips `code`/`state` once the
      // exchange completes; a later re-render must not re-read the URL
      setSearch('')
      rerender(<AppRoot />)

      // Assert — still the launched branch
      expect(screen.getByTestId('app-stub')).toBeDefined()
      expect(screen.queryByTestId('connect-menu-stub')).toBeNull()
    })
  })
})
