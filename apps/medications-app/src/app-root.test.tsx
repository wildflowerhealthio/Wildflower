import { cleanup, render, screen, within } from '@testing-library/react'
import { APP_DESCRIPTIONS } from 'branding-core'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type * as SmartModule from 'fhir-r4-react/smart'

// Stub the two leaf components `AppRoot` branches between (the SMART app and the
// standalone connect menu) and the live URL check that picks the branch. The
// branding chrome (`BrandBar`, `SiteHeader`, `SiteFooter`) and the query client
// render for real so the assertions run against their actual DOM output.
const { shouldCompleteSmartLaunchMock } = vi.hoisted(() => ({
  shouldCompleteSmartLaunchMock: vi.fn<() => boolean>(),
}))
vi.mock('./app.tsx', () => ({
  App: () => <div data-testid="app" />,
}))
vi.mock('fhir-r4-react/connect', () => ({
  ConnectMenu: ({ redirectUri }: { readonly redirectUri: string }) => (
    <div data-testid="connect-menu" data-redirect-uri={redirectUri} />
  ),
}))
vi.mock('fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof SmartModule>()),
  shouldCompleteSmartLaunch: () => shouldCompleteSmartLaunchMock(),
}))

const { AppRoot } = await import('./app-root.tsx')

const MARKETING_ORIGIN = 'https://wildflowerhealth.io/'

afterEach(() => {
  cleanup()
  shouldCompleteSmartLaunchMock.mockReset()
})

describe('AppRoot', () => {
  it('should render the brand bar over the SMART app when launched', () => {
    // Arrange / Act
    renderAppRoot({ launched: true })

    // Assert — the brand bar is a single link back to the marketing site
    const brandLink = within(screen.getByRole('banner')).getByRole('link', {
      name: 'Wildflower, home',
    })
    expect(brandLink.getAttribute('href')).toBe(MARKETING_ORIGIN)

    // The SMART app renders, not the connect menu
    expect(screen.queryByTestId('app')).not.toBeNull()
    expect(screen.queryByTestId('connect-menu')).toBeNull()

    // No full site header, nav, or footer in the launched branch
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull()
    expect(screen.queryByRole('contentinfo')).toBeNull()
  })

  it('should render the site header, connect menu, and footer when not launched', () => {
    // Arrange / Act
    renderAppRoot({ launched: false })

    // Assert — full site chrome: header with the primary nav, a main region, a footer
    expect(screen.getByRole('banner').id).toBe('top')
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeNull()
    expect(screen.queryByRole('contentinfo')).not.toBeNull()

    // The connect menu renders inside the main region, not the SMART app
    const connectMenu = within(screen.getByRole('main')).getByTestId('connect-menu')
    // The OAuth callback must land back on this page root, wherever it is served from
    expect(connectMenu.getAttribute('data-redirect-uri')).toBe(`${window.location.origin}/`)
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('should introduce the Medication Viewer beside the connect menu when not launched', () => {
    // Arrange / Act
    renderAppRoot({ launched: false })

    // Assert — the app name is the page's only h1 (the site header's brand is a div)
    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0].textContent).toBe(APP_DESCRIPTIONS.medications.name)

    // The homepage's copy and a link to its section sit in the same main region
    const main = within(screen.getByRole('main'))
    expect(main.getByText(APP_DESCRIPTIONS.medications.paragraphs[0])).toBeDefined()
    expect(main.getByRole('link', { name: /Read the whole story/ }).getAttribute('href')).toBe(
      `${MARKETING_ORIGIN}#built`
    )
  })

  it('should resolve every header nav link as an absolute marketing-site URL', () => {
    // Arrange / Act
    renderAppRoot({ launched: false })

    // Assert — the brand link and every nav link leave the app for the marketing site
    const brandLink = screen.getByRole('link', { name: 'Wildflower, home' })
    expect(brandLink.getAttribute('href')).toBe(MARKETING_ORIGIN)

    const navLinks = within(screen.getByRole('navigation', { name: 'Primary' })).getAllByRole(
      'link'
    )
    const hrefs = navLinks.map((link) => link.getAttribute('href'))
    expect(hrefs).not.toHaveLength(0)
    for (const href of hrefs) {
      expect(href).toMatch(/^https:\/\/wildflowerhealth\.io\//)
    }
  })

  it('should default `launched` to the live SMART-callback check', () => {
    // Arrange
    shouldCompleteSmartLaunchMock.mockReturnValue(true)

    // Act
    renderAppRoot({})

    // Assert — a callback in the URL selects the launched branch
    expect(screen.queryByTestId('app')).not.toBeNull()
    expect(screen.queryByTestId('connect-menu')).toBeNull()
  })

  it('should show the connect menu by default when the URL carries no SMART callback', () => {
    // Arrange
    shouldCompleteSmartLaunchMock.mockReturnValue(false)

    // Act
    renderAppRoot({})

    // Assert — a bare visit selects the standalone branch
    expect(screen.queryByTestId('connect-menu')).not.toBeNull()
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('should keep the SMART app mounted after the callback check turns false', () => {
    // Arrange — a launch in progress
    shouldCompleteSmartLaunchMock.mockReturnValue(true)
    const { rerender } = render(<AppRoot />)
    expect(screen.queryByTestId('app')).not.toBeNull()

    // Act — fhirclient's `oauth2.ready()` strips `code`/`state` once the
    // exchange completes; a later re-render must not re-read the URL
    shouldCompleteSmartLaunchMock.mockReturnValue(false)
    rerender(<AppRoot />)

    // Assert — still the launched branch
    expect(screen.queryByTestId('app')).not.toBeNull()
    expect(screen.queryByTestId('connect-menu')).toBeNull()
  })
})

// Helpers

/** Render `AppRoot` under StrictMode, as `main.tsx` does. */
function renderAppRoot({ launched }: { readonly launched?: boolean }): void {
  render(
    <StrictMode>
      <AppRoot launched={launched} />
    </StrictMode>
  )
}
