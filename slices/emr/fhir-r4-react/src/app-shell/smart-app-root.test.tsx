import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { APP_DESCRIPTIONS, APP_SECTION_IDS, type AppSectionId } from 'branding-core'
import { StrictMode, type JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import type { ConnectMenuProps } from '../connect/connect-menu.tsx'
import { encodeLaunchError } from '../smart/launch-error.ts'
import type * as SmartLaunch from '../smart/smart-launch.ts'
import { SMART_HANDSHAKE_QUERY_KEY, useSmartHandshake } from '../smart/use-smart-handshake.ts'
import { SmartAppRoot } from './smart-app-root.tsx'

// The stub echoes the props it was handed as data attributes so the wiring
// (`clientId` / `scope` from the `standalone` prop, `redirectUri` from the URL)
// is observable. The branding chrome renders for real.
vi.mock('../connect/connect-menu.tsx', () => ({
  ConnectMenu: ({ clientId, scope, redirectUri }: ConnectMenuProps) => (
    <div
      data-testid="connect-menu-stub"
      data-client-id={clientId}
      data-scope={scope}
      data-redirect-uri={redirectUri}
    />
  ),
}))

// The token exchange never settles, so a handshake started under the shell
// stays in flight — observable in the query cache, never reaching the network.
vi.mock('../smart/smart-launch.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof SmartLaunch>()),
  readySmartClient: () => new Promise<never>(() => undefined),
}))

const STANDALONE = {
  clientId: 'medications-app',
  scope: 'launch openid fhirUser system/MedicationRequest.rs',
}

const MARKETING_ORIGIN = 'https://wildflowerhealth.io/'

afterEach(() => {
  cleanup()
  setUrl('/')
})

describe('SmartAppRoot', () => {
  it('should render the brand bar over its children when launched', () => {
    // Arrange / Act
    renderShell({ launched: true })

    // Assert — the brand bar is a single link back to the marketing site
    const brandLink = within(screen.getByRole('banner')).getByRole('link', {
      name: 'Wildflower, home',
    })
    expect(brandLink.getAttribute('href')).toBe(MARKETING_ORIGIN)
    expect(screen.queryByTestId('app')).not.toBeNull()

    // No connect menu, and no full site header nav or footer
    expect(screen.queryByTestId('connect-menu-stub')).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Apps' })).toBeNull()
    expect(screen.queryByRole('contentinfo')).toBeNull()
  })

  it('should render the site header, connect menu, and footer when not launched', () => {
    // Arrange / Act
    renderShell({ launched: false })

    // Assert — full site chrome: header with the primary nav, a main region, a footer
    expect(screen.getByRole('banner').id).toBe('top')
    expect(screen.queryByRole('navigation', { name: 'Apps' })).not.toBeNull()
    expect(screen.queryByRole('contentinfo')).not.toBeNull()

    // The connect menu renders inside the main region; the children do not render
    expect(within(screen.getByRole('main')).queryByTestId('connect-menu-stub')).not.toBeNull()
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('should hand the connect menu the standalone config and this root as its redirect', () => {
    // Arrange — served from a subpath, with a query that must not leak into the redirect
    setUrl('/importer-app/index.html?utm_source=email')

    // Act
    renderShell({ launched: false })

    // Assert
    const menu = screen.getByTestId('connect-menu-stub')
    expect(menu.getAttribute('data-client-id')).toBe(STANDALONE.clientId)
    expect(menu.getAttribute('data-scope')).toBe(STANDALONE.scope)
    expect(menu.getAttribute('data-redirect-uri')).toBe(`${window.location.origin}/importer-app/`)
  })

  it('should resolve every header nav link as an absolute marketing-site URL', () => {
    // Arrange / Act
    renderShell({ launched: false })

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

  it.each(APP_SECTION_IDS)(
    'should introduce "%s" as the page’s only h1 when not launched',
    (app) => {
      // Arrange / Act
      renderShell({ app, launched: false })

      // Assert — the site header's brand is a div, so the app name is the only h1
      const headings = screen.getAllByRole('heading', { level: 1 })
      expect(headings.map((heading) => heading.textContent)).toEqual([APP_DESCRIPTIONS[app].name])
      expect(
        within(screen.getByRole('main')).getByText(APP_DESCRIPTIONS[app].paragraphs[0])
      ).toBeDefined()
    }
  )

  describe('with no `launched` prop, the URL decides', () => {
    it.each([
      { search: '?code=abc&state=xyz', expectApp: true },
      { search: '?state=xyz', expectApp: true },
      { search: '', expectApp: false },
      { search: '?utm_source=email', expectApp: false },
      { search: '?error=access_denied&state=xyz', expectApp: false },
    ])('should render children=$expectApp for "$search"', ({ search, expectApp }) => {
      // Arrange
      setUrl(`/${search}`)

      // Act
      renderShell({})

      // Assert — exactly one of the two branches is mounted
      expect(screen.queryByTestId('app') !== null).toBe(expectApp)
      expect(screen.queryByTestId('connect-menu-stub') !== null).toBe(!expectApp)
    })
  })

  it('should keep the children mounted after the callback params leave the URL', () => {
    // Arrange — a launch in progress
    setUrl('/?code=abc&state=xyz')
    const { rerender } = render(<Shell />)
    expect(screen.queryByTestId('app')).not.toBeNull()

    // Act — fhirclient's `oauth2.ready()` strips `code`/`state` once the
    // exchange completes; a later re-render must not re-read the URL
    setUrl('/')
    rerender(<Shell />)

    // Assert — still the launched branch
    expect(screen.queryByTestId('app')).not.toBeNull()
    expect(screen.queryByTestId('connect-menu-stub')).toBeNull()
  })

  it('should ignore a flip of the `launched` prop after mount', () => {
    // Arrange
    const { rerender } = render(<Shell launched={false} />)
    expect(screen.queryByTestId('connect-menu-stub')).not.toBeNull()

    // Act
    rerender(<Shell launched />)

    // Assert — still the standalone branch it mounted with
    expect(screen.queryByTestId('connect-menu-stub')).not.toBeNull()
    expect(screen.queryByTestId('app')).toBeNull()
  })

  it('should run the children’s SMART handshake on the one client it provides', () => {
    // Arrange
    const seen: QueryClient[] = []

    // Act — rendered twice (StrictMode) and then re-rendered
    const { rerender } = render(
      <StrictMode>
        <SmartAppRoot app="medications" standalone={STANDALONE} launched>
          <HandshakeProbe seen={seen} />
        </SmartAppRoot>
      </StrictMode>
    )
    rerender(
      <StrictMode>
        <SmartAppRoot app="medications" standalone={STANDALONE} launched>
          <HandshakeProbe seen={seen} />
        </SmartAppRoot>
      </StrictMode>
    )

    // Assert — every render saw the same client, and the handshake query lives on it
    expect(new Set(seen).size).toBe(1)
    expect(seen[0].getQueryCache().find({ queryKey: SMART_HANDSHAKE_QUERY_KEY })).toBeDefined()
  })

  it('should report a failed launch in an alert beside the connect menu', () => {
    // Arrange — the URL the launch page redirects to when `authorizeSmartLaunch`
    // rejects (an unreachable or CORS-blocked `iss`).
    const encoded = encodeLaunchError({
      error: 'AuthorizeFailed',
      message: 'Failed to fetch',
      iss: 'https://ruth.wildflowerhealth.io/fhir-r4',
    })
    setUrl(`/?launchError=${encoded}`)

    // Act
    renderShell({ launched: false })

    // Assert — the failure is announced, and the retry is still right there
    expect(screen.getByRole('alert').textContent).toContain('Failed to fetch')
    expect(screen.queryByTestId('connect-menu-stub')).not.toBeNull()
  })

  it('should report the authorization server’s own OAuth error return', () => {
    // Arrange — `shouldCompleteSmartLaunch` deliberately ignores an `error=`
    // return, which is exactly what would otherwise make this landing silent.
    setUrl('/?error=access_denied&error_description=The+user+declined&state=xyz')

    // Act
    renderShell({})

    // Assert
    expect(screen.getByRole('alert').textContent).toContain('The user declined')
  })

  it('should render no alert on a plain visit', () => {
    // Arrange / Act — the resting state: nothing failed, so nothing is announced.
    renderShell({ launched: false })

    // Assert
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// Helpers

/** Points jsdom's location at `url` (a path plus optional query). */
function setUrl(url: string): void {
  window.history.replaceState({}, '', url)
}

/** The shell around a stub app, with the test's standalone config. */
function Shell({ launched }: { readonly launched?: boolean }): JSX.Element {
  return (
    <SmartAppRoot app="medications" standalone={STANDALONE} launched={launched}>
      <div data-testid="app" />
    </SmartAppRoot>
  )
}

/** Render the shell under StrictMode, as an app's `main.tsx` does. */
function renderShell({
  app = 'medications',
  launched,
}: {
  readonly app?: AppSectionId
  readonly launched?: boolean
}): void {
  render(
    <StrictMode>
      <SmartAppRoot app={app} standalone={STANDALONE} launched={launched}>
        <div data-testid="app" />
      </SmartAppRoot>
    </StrictMode>
  )
}

/** Starts the SMART handshake and records the client it was provided. */
function HandshakeProbe({ seen }: { readonly seen: QueryClient[] }): null {
  seen.push(useQueryClient())
  useSmartHandshake()
  return null
}
