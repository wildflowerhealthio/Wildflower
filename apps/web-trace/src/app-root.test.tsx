import { cleanup, render, screen, within } from '@testing-library/react'
import { APP_DESCRIPTIONS } from 'branding-core'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

vi.mock('./app.tsx', () => ({
  App: (): JSX.Element => <div data-testid="mock-app">App</div>,
}))

vi.mock('fhir-r4-react/connect', () => ({
  ConnectMenu: ({
    clientId,
    scope,
    redirectUri,
  }: {
    readonly clientId: string
    readonly scope: string
    readonly redirectUri: string
  }): JSX.Element => (
    <div data-testid="mock-connect-menu" data-redirect-uri={redirectUri}>
      {clientId} / {scope} / {redirectUri}
    </div>
  ),
}))

/** Points jsdom's location at `search` (a `?…` string, or `''` for the bare root). */
const setSearch = (search: string): void => {
  window.history.replaceState({}, '', `/${search}`)
}

afterEach(() => {
  cleanup()
  setSearch('')
})

const { AppRoot } = await import('./app-root.tsx')

describe('AppRoot', () => {
  it('should render BrandBar and App when launched', () => {
    // Arrange & Act
    render(<AppRoot launched />)

    // Assert — the slim brand bar links back to the marketing site
    const brandLink = screen.getByRole('link', { name: 'Wildflower, home' })
    expect(brandLink).toBeDefined()
    expect(brandLink.getAttribute('href')).toBe('https://wildflowerhealth.io/')

    expect(screen.getByTestId('mock-app')).toBeDefined()
    expect(screen.queryByTestId('mock-connect-menu')).toBeNull()
  })

  it('should render full site chrome and ConnectMenu when not launched', () => {
    // Arrange & Act
    render(<AppRoot launched={false} />)

    // Assert — SiteHeader renders with id="top"
    expect(document.getElementById('top')).not.toBeNull()

    // SiteHeader nav links resolve into the apps as absolute canonical URLs
    const header = document.getElementById('top')!
    const medicationsLink = within(header).getByRole('link', { name: 'Medications' })
    expect(medicationsLink.getAttribute('href')).toBe('https://wildflowerhealth.io/medications-app')

    const serverDocsLink = within(header).getByRole('link', { name: 'Server docs' })
    expect(serverDocsLink.getAttribute('href')).toBe(
      'https://wildflowerhealth.io/wildflower-server-docs'
    )

    // ConnectMenu is present, and its redirect target is this page's root
    // (the OAuth callback lands back on AppRoot, wherever it is served from)
    const connectMenu = screen.getByTestId('mock-connect-menu')
    expect(connectMenu.getAttribute('data-redirect-uri')).toBe(`${window.location.origin}/`)

    // SiteFooter is present (the footer landmark)
    expect(screen.getByRole('contentinfo')).toBeDefined()

    // App is absent
    expect(screen.queryByTestId('mock-app')).toBeNull()
  })

  it('should introduce the Web Trace Viewer beside the connect menu when not launched', () => {
    // Arrange & Act
    render(<AppRoot launched={false} />)

    // Assert — the app name is the page's only h1 (the site header's brand is a div)
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0].textContent).toBe(APP_DESCRIPTIONS.webTrace.name)

    // The homepage's copy and a link to its section sit in the same main region
    const main = within(screen.getByRole('main'))
    expect(main.getByText(APP_DESCRIPTIONS.webTrace.paragraphs[0])).toBeDefined()
    expect(main.getByRole('link', { name: /rest of the project/ }).getAttribute('href')).toBe(
      'https://wildflowerhealth.io/#developers'
    )
  })

  it('should not render SiteHeader or SiteFooter when launched', () => {
    // Arrange & Act
    render(<AppRoot launched />)

    // Assert — no full header (id="top" is SiteHeader's marker)
    expect(document.getElementById('top')).toBeNull()
  })

  it('should keep App mounted after the callback params leave the URL', () => {
    // Arrange — a launch in progress, with no explicit prop so the URL decides
    setSearch('?code=abc&state=xyz')
    const { rerender } = render(<AppRoot />)
    expect(screen.getByTestId('mock-app')).toBeDefined()

    // Act — fhirclient's `oauth2.ready()` strips `code`/`state` once the
    // exchange completes; a later re-render must not re-read the URL
    setSearch('')
    rerender(<AppRoot />)

    // Assert — still the launched branch
    expect(screen.getByTestId('mock-app')).toBeDefined()
    expect(screen.queryByTestId('mock-connect-menu')).toBeNull()
  })
})
