import { cleanup, render, screen, within } from '@testing-library/react'
import { APP_DESCRIPTIONS } from 'branding-core'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { encodeLaunchError } from 'fhir-r4-react/smart'
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
  window.history.replaceState({}, '', '/')
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
    expect(screen.queryByRole('navigation', { name: 'Apps' })).toBeNull()
    expect(screen.queryByRole('contentinfo')).toBeNull()
  })

  it('should render the site header, connect menu, and footer when not launched', () => {
    // Arrange / Act
    renderAppRoot({ launched: false })

    // Assert — full site chrome: header with the primary nav, a main region, a footer
    expect(screen.getByRole('banner').id).toBe('top')
    expect(screen.queryByRole('navigation', { name: 'Apps' })).not.toBeNull()
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
    expect(main.getByRole('link', { name: /rest of the project/ }).getAttribute('href')).toBe(
      `${MARKETING_ORIGIN}#built`
    )
  })

  it('should resolve every header nav link as an absolute marketing-site URL', () => {
    // Arrange / Act
    renderAppRoot({ launched: false })

    // Assert — the brand link and every nav link leave the app for the marketing site
    const brandLink = screen.getByRole('link', { name: 'Wildflower, home' })
    expect(brandLink.getAttribute('href')).toBe(MARKETING_ORIGIN)

    const navLinks = within(screen.getByRole('navigation', { name: 'Apps' })).getAllByRole('link')
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

  it('should report a failed launch in an alert beside the connect menu', () => {
    // Arrange — the URL the launch page redirects to when `authorizeSmartLaunch`
    // rejects (an unreachable or CORS-blocked `iss`).
    const encoded = encodeLaunchError({
      error: 'AuthorizeFailed',
      message: 'Failed to fetch',
      iss: 'https://ruth.wildflowerhealth.io/fhir-r4',
    })
    window.history.replaceState({}, '', `/?launchError=${encoded}`)

    // Act
    renderAppRoot({ launched: false })

    // Assert — the failure is announced, and names the thing that went wrong
    // rather than leaving the user on a bare connect menu.
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Failed to fetch')
    // The retry is still right there.
    expect(screen.queryByTestId('connect-menu')).not.toBeNull()
  })

  it('should report the authorization server’s own OAuth error return', () => {
    // Arrange — `shouldCompleteSmartLaunch` deliberately ignores an `error=`
    // return, which is exactly what used to make this landing silent.
    window.history.replaceState(
      {},
      '',
      '/?error=access_denied&error_description=The+user+declined&state=xyz'
    )

    // Act
    renderAppRoot({ launched: false })

    // Assert
    expect(screen.getByRole('alert').textContent).toContain('The user declined')
  })

  it('should render no alert on a plain visit', () => {
    // Arrange / Act — the resting state: nothing failed, so nothing is announced.
    renderAppRoot({ launched: false })

    // Assert
    expect(screen.queryByRole('alert')).toBeNull()
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
