import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  APP_DESCRIPTIONS,
  APP_SECTION_IDS,
  TELEMETRY_CONSENT_COPY,
  type AppSectionId,
} from 'branding-core'
import { Option } from 'effect'
import type Client from 'fhirclient/lib/Client'
import { StrictMode, type JSX } from 'react'
import { type TelemetryConsent, writeConsent } from 'telemetry-core'
import type * as TelemetryWeb from 'telemetry-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { decodeLaunchError, encodeLaunchError, useSmartHandshake } from 'fhir-r4-react/smart'

import type * as AuthorizeFromLaunchPage from './authorize-from-launch-page.ts'
import type { ConnectMenuProps } from './connect-menu.tsx'
import { SmartAppRoot, type SmartAppTelemetry } from './smart-app-root.tsx'

/** The part of Sentry's `captureException` hint the root sets. */
interface CaptureHint {
  readonly tags?: Readonly<Record<string, string>>
  readonly extra?: { readonly componentStack?: string }
}

// The telemetry SDK is the collaborator whose every touch the gate controls, so
// the module boundary is where it is stubbed: each test reads back whether, and
// with what, the root started telemetry and reported. The rest of the module
// stays real, so the config the root builds is the one an app would get.
const { initConsentedTelemetryMock, setFhirServerHostMock, captureExceptionMock } = vi.hoisted(
  () => ({
    initConsentedTelemetryMock: vi.fn<typeof TelemetryWeb.initConsentedTelemetry>(() => false),
    setFhirServerHostMock: vi.fn<typeof TelemetryWeb.setFhirServerHost>(),
    captureExceptionMock: vi.fn<(exception: unknown, hint?: CaptureHint) => string>(
      () => 'event-id'
    ),
  })
)
vi.mock('telemetry-web', async (importOriginal) => {
  const actual = await importOriginal<typeof TelemetryWeb>()
  return {
    ...actual,
    initConsentedTelemetry: initConsentedTelemetryMock,
    setFhirServerHost: setFhirServerHostMock,
    Sentry: { captureException: captureExceptionMock },
  }
})

// fhirclient's `oauth2.ready()` is the token exchange the app's handshake runs;
// by default it resolves to a client connected to `FHIR_SERVER_URL`, and the
// spy counts how often the single-use code would have been posted. Its
// `oauth2.authorize()` is the redirect a launch the page arrives with starts;
// the spy counts how often the single-use launch would have been spent.
const FHIR_SERVER_URL = 'https://fhir.example:8443/r4'
const { tokenExchangeMock, authorizeMock } = vi.hoisted(() => ({
  tokenExchangeMock: vi.fn(() => Promise.resolve(clientConnectedTo(FHIR_SERVER_URL))),
  authorizeMock: vi.fn<(params: Record<string, unknown>) => Promise<void>>(),
}))
vi.mock('fhirclient', () => ({
  default: { oauth2: { ready: tokenExchangeMock, authorize: authorizeMock } },
}))

// The root's own authorize entry, spied through to the real one: it counts
// every authorize the root starts. Under StrictMode's second effect run the
// mocked fhirclient import above can resolve to the real package, whose
// `oauth2` is absent under jsdom, so a second authorize would fail before it
// reached `authorizeMock`; this count sees it either way.
const { authorizeFromLaunchPageSpy } = vi.hoisted(() => ({
  authorizeFromLaunchPageSpy: vi.fn<typeof AuthorizeFromLaunchPage.authorizeFromLaunchPage>(),
}))
vi.mock('./authorize-from-launch-page.ts', () => ({
  authorizeFromLaunchPage: authorizeFromLaunchPageSpy,
}))

// The stubbed connect menu throws this from render when it is set, as a
// crashing menu would.
const connectMenuRenderFailure: { current: Error | undefined } = { current: undefined }

// The stub echoes the props it was handed as data attributes so the wiring
// (the SMART target, `clientId` / `scope` from the `registration` prop,
// `redirectUri` from the URL, the latched launch failure as `arrivalProblem`)
// is observable. The branding chrome renders for real; the menu's own banner is
// `connect-menu.test.tsx`'s.
vi.mock('./connect-menu.tsx', () => ({
  ConnectMenu: (props: ConnectMenuProps) => {
    if (connectMenuRenderFailure.current !== undefined) throw connectMenuRenderFailure.current
    return (
      <div
        data-testid="connect-menu-stub"
        data-target={props.target}
        data-client-id={props.target === 'fhir-r4' ? props.clientId : undefined}
        data-scope={props.target === 'fhir-r4' ? props.scope : undefined}
        data-redirect-uri={props.target === 'fhir-r4' ? props.redirectUri : undefined}
        data-arrival-problem={
          props.arrivalProblem instanceof Error
            ? props.arrivalProblem.message
            : props.arrivalProblem
        }
      />
    )
  },
}))

const REGISTRATION = {
  clientId: '9769f8b274370708d0d3ebb2e3e59b7c',
  scope: 'launch openid fhirUser system/MedicationRequest.rs',
}

const TELEMETRY: SmartAppTelemetry = {
  dsn: 'https://key@sentry.example/42',
  app: 'medications-web',
}

const MARKETING_ORIGIN = 'https://wildflowerhealth.io/'

const STATUS_CONTROL_NAME = /change telemetry settings/

/** An EHR launch, as the desktop base opens a server's launcher with it. */
const EHR_LAUNCH = '?iss=https%3A%2F%2Fruth.wildflowerhealth.io%2Ffhir-r4&launch=xyz'

/** A launch the launch page could not start, as it lands in `?launchError=`. */
const FAILED_LAUNCH = encodeLaunchError({
  error: 'AuthorizeFailed',
  message: 'Failed to fetch',
  iss: 'https://ruth.wildflowerhealth.io/fhir-r4',
})

beforeEach(() => {
  stubDialogModality()
})

afterEach(() => {
  cleanup()
  setUrl('/')
  window.localStorage.clear()
  restoreDialogModality()
  connectMenuRenderFailure.current = undefined
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

describe('SmartAppRoot', () => {
  // The chrome and branch tests below run past the consent dialog, as a
  // returning visitor who declined both switches does.
  beforeEach(() => {
    storeConsent({ crashReports: false, performance: false })
  })

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

  it('should hand the connect menu the SMART target, the registration and this root as its redirect', () => {
    // Arrange — served from a subpath, with a query that must not leak into the redirect
    setUrl('/importer/index.html?utm_source=email')

    // Act
    renderShell({ launched: false })

    // Assert
    const menu = screen.getByTestId('connect-menu-stub')
    expect(menu.getAttribute('data-target')).toBe('fhir-r4')
    expect(menu.getAttribute('data-client-id')).toBe(REGISTRATION.clientId)
    expect(menu.getAttribute('data-scope')).toBe(REGISTRATION.scope)
    expect(menu.getAttribute('data-redirect-uri')).toBe(`${window.location.origin}/importer/`)
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
        <SmartAppRoot app="medications" registration={REGISTRATION} telemetry={TELEMETRY} launched>
          <HandshakeProbe seen={seen} />
        </SmartAppRoot>
      </StrictMode>
    )
    rerender(
      <StrictMode>
        <SmartAppRoot app="medications" registration={REGISTRATION} telemetry={TELEMETRY} launched>
          <HandshakeProbe seen={seen} />
        </SmartAppRoot>
      </StrictMode>
    )

    // Assert — every render saw the same client, and the one handshake query
    // (StrictMode's double mount included) lives on it
    expect(new Set(seen).size).toBe(1)
    expect(seen[0].getQueryCache().getAll()).toHaveLength(1)
  })

  it('should hand a failed launch to the connect menu as its arrival problem', () => {
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

    // Assert — the menu shows the failure, with the retry right there
    expect(arrivalProblem()).toContain('Failed to fetch')
  })

  it('should report the authorization server’s own OAuth error return', () => {
    // Arrange — `shouldCompleteSmartLaunch` deliberately ignores an `error=`
    // return, which is exactly what would otherwise make this landing silent.
    setUrl('/?error=access_denied&error_description=The+user+declined&state=xyz')

    // Act
    renderShell({})

    // Assert
    expect(arrivalProblem()).toContain('The user declined')
  })

  it('should hand the menu no arrival problem on a plain visit', () => {
    // Arrange / Act — the resting state: nothing failed, so nothing is announced.
    renderShell({ launched: false })

    // Assert
    expect(arrivalProblem()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('SmartAppRoot on a launch', () => {
  beforeEach(async () => {
    // Discovery never settles, as while the authorize redirect is pending
    authorizeMock.mockReturnValue(new Promise<never>(() => undefined))
    const actual = await vi.importActual<typeof AuthorizeFromLaunchPage>(
      './authorize-from-launch-page.ts'
    )
    authorizeFromLaunchPageSpy.mockImplementation(actual.authorizeFromLaunchPage)
  })

  // The tests below run as a returning visitor, whose stored answer skips the
  // dialog, unless they say otherwise.
  describe('with a stored consent answer', () => {
    beforeEach(() => {
      storeConsent({ crashReports: false, performance: false })
    })

    it.each([
      { case: 'an EHR launch', search: EHR_LAUNCH },
      { case: 'a lone iss', search: '?iss=https%3A%2F%2Ffhir.example%2Fr4' },
    ])('should authorize $case once, from the app root, under StrictMode', async ({ search }) => {
      // Arrange
      setUrl(`/importer/${search}`)

      // Act
      renderShell({})

      // Assert — the registration, with this root as the redirect; fhirclient
      // reads `iss` and `launch` off the URL itself
      await waitFor(() => {
        expect(authorizeMock).toHaveBeenCalledTimes(1)
      })
      expect(authorizeMock).toHaveBeenCalledWith({
        ...REGISTRATION,
        redirectUri: `${window.location.origin}/importer/`,
      })
      expect(authorizeFromLaunchPageSpy).toHaveBeenCalledTimes(1)
    })

    it('should show the launch page, naming the app, with no dialog', async () => {
      // Arrange
      setUrl(`/${EHR_LAUNCH}`)

      // Act
      renderShell({ app: 'importer' })

      // Assert — the launch page alone: no dialog, no app, no connect menu
      expect(screen.getByText(`Launching ${APP_DESCRIPTIONS.importer.name}…`)).toBeDefined()
      expect(screen.getByRole('link', { name: 'Wildflower, home' })).toBeDefined()
      expect(openDialog()).toBeNull()
      expect(screen.queryByTestId('app')).toBeNull()
      expect(screen.queryByTestId('connect-menu-stub')).toBeNull()
      await waitFor(() => {
        expect(authorizeMock).toHaveBeenCalledTimes(1)
      })
    })

    it('should not authorize again on a later render with a new registration object', async () => {
      // Arrange — a fresh, equal registration on every render re-runs the
      // authorize effect, so only the guard keeps the launch from being spent
      // twice
      setUrl(`/${EHR_LAUNCH}`)
      const { rerender } = render(<Shell registration={{ ...REGISTRATION }} />)
      await waitFor(() => {
        expect(authorizeMock).toHaveBeenCalledTimes(1)
      })

      // Act
      rerender(<Shell registration={{ ...REGISTRATION }} />)

      // Assert
      expect(authorizeFromLaunchPageSpy).toHaveBeenCalledTimes(1)
    })

    it('should send a launch that fails to start to the app root as ?launchError, once', async () => {
      // Arrange — discovery fails, as for an unreachable iss
      authorizeMock.mockRejectedValue(new Error('Failed to fetch'))
      const replaceLocation = vi.fn<(url: string) => void>()
      setUrl(`/importer/${EHR_LAUNCH}`)

      // Act
      renderShell({ replaceLocation })

      // Assert — one navigation, to the bare app root carrying the failure
      await waitFor(() => {
        expect(replaceLocation).toHaveBeenCalledTimes(1)
      })
      const target = new URL(replaceLocation.mock.calls[0]?.[0] ?? '')
      expect(`${target.origin}${target.pathname}`).toBe(`${window.location.origin}/importer/`)
      expect([...target.searchParams.keys()]).toStrictEqual(['launchError'])
      expect(decodeLaunchError(target.searchParams.get('launchError') ?? '')).toStrictEqual(
        Option.some({
          error: 'AuthorizeFailed',
          message: 'Failed to fetch',
          iss: 'https://ruth.wildflowerhealth.io/fhir-r4',
        })
      )
    })

    it('should leave for the bare app root when restored from the back-forward cache', async () => {
      // Arrange — the launch has left for the authorization server
      const replaceLocation = vi.fn<(url: string) => void>()
      setUrl(`/importer/${EHR_LAUNCH}`)
      renderShell({ replaceLocation })
      await waitFor(() => {
        expect(authorizeMock).toHaveBeenCalledTimes(1)
      })

      // Act — an ordinary `pageshow` (a fresh load) is not a restore
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))

      // Assert
      expect(replaceLocation).not.toHaveBeenCalled()

      // Act — Back from the authorization server restores the page
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))

      // Assert — a plain visit to the app root, and the spent launch not reused
      expect(replaceLocation.mock.calls).toStrictEqual([[`${window.location.origin}/importer/`]])
      expect(authorizeFromLaunchPageSpy).toHaveBeenCalledTimes(1)
    })

    it.each([
      { case: 'a callback', search: `${EHR_LAUNCH}&code=abc&state=xyz`, expectApp: true },
      {
        case: 'an OAuth error return',
        search: `${EHR_LAUNCH}&error=access_denied`,
        expectApp: false,
      },
      { case: 'a lone launch', search: '?launch=xyz', expectApp: false },
    ])('should not start a launch on $case', ({ search, expectApp }) => {
      // Arrange
      setUrl(`/${search}`)

      // Act
      renderShell({})

      // Assert — the callback or the landing, and no authorize
      expect(screen.queryByTestId('app') !== null).toBe(expectApp)
      expect(screen.queryByTestId('connect-menu-stub') !== null).toBe(!expectApp)
      expect(authorizeFromLaunchPageSpy).not.toHaveBeenCalled()
    })
  })

  it('should not authorize before the visitor answers, and authorize once after', async () => {
    // Arrange — a first visit: no stored answer, under StrictMode
    setUrl(`/${EHR_LAUNCH}`)
    renderShell({ app: 'importer' })

    // Assert — the dialog alone, and the launch not yet spent
    expect(openDialog()).not.toBeNull()
    expect(screen.queryByText(`Launching ${APP_DESCRIPTIONS.importer.name}…`)).toBeNull()
    expect(authorizeFromLaunchPageSpy).not.toHaveBeenCalled()

    // Act
    answerDialog({ crashReports: true, performance: false })

    // Assert — telemetry tagged for the launch, then one authorize
    await waitFor(() => {
      expect(authorizeMock).toHaveBeenCalledTimes(1)
    })
    expect(authorizeFromLaunchPageSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByText(`Launching ${APP_DESCRIPTIONS.importer.name}…`)).toBeDefined()
    expect(initConsentedTelemetryMock.mock.calls[0]?.[0].tags).toStrictEqual({
      app: TELEMETRY.app,
      launch: 'launching',
    })
  })
})

describe('SmartAppRoot telemetry consent', () => {
  describe.each([
    { branch: 'launched', launched: true },
    { branch: 'standalone', launched: false },
  ])('on the $branch branch', ({ launched }) => {
    it('should show only the consent dialog, and start nothing, until the visitor answers', () => {
      // Arrange — a failed launch to report, were anything allowed to report it
      setUrl(`/?launchError=${FAILED_LAUNCH}`)

      // Act
      renderShell({ launched })

      // Assert — the dialog alone: no app, no connect menu, no status control
      expect(openDialog()).not.toBeNull()
      expect(screen.queryByTestId('app')).toBeNull()
      expect(screen.queryByTestId('connect-menu-stub')).toBeNull()
      expect(screen.queryByRole('button', { name: STATUS_CONTROL_NAME })).toBeNull()
      expect(initConsentedTelemetryMock).not.toHaveBeenCalled()
      expect(captureExceptionMock).not.toHaveBeenCalled()
      expect(setFhirServerHostMock).not.toHaveBeenCalled()
    })

    it('should start telemetry with the app’s DSN and tags once the visitor says yes', () => {
      // Arrange
      renderShell({ launched })

      // Act
      answerDialog({ crashReports: true, performance: false })

      // Assert
      expect(initConsentedTelemetryMock).toHaveBeenCalledTimes(1)
      const [{ consent, config, tags }] = initConsentedTelemetryMock.mock.calls[0]
      expect(consent).toMatchObject({ crashReports: true, performance: false })
      expect(config.sentry.dsn).toBe(TELEMETRY.dsn)
      expect(config.otel.serviceName).toBe(TELEMETRY.app)
      expect(tags).toStrictEqual({
        app: TELEMETRY.app,
        launch: launched ? 'launched' : 'standalone',
      })
    })

    it('should show the status control, and reopen the dialog from it', () => {
      // Arrange
      storeConsent({ crashReports: false, performance: true })
      renderShell({ launched })
      expect(openDialog()).toBeNull()

      // Act
      fireEvent.click(screen.getByRole('button', { name: STATUS_CONTROL_NAME }))

      // Assert
      expect(openDialog()).not.toBeNull()
    })
  })

  it('should put the status control at the end of the brand bar when launched', () => {
    // Arrange
    storeConsent({ crashReports: false, performance: false })

    // Act
    renderShell({ launched: true })

    // Assert — in the banner, outside the link home
    const banner = screen.getByRole('banner')
    const control = within(banner).getByRole('button', { name: STATUS_CONTROL_NAME })
    expect(within(banner).getByRole('link', { name: 'Wildflower, home' }).contains(control)).toBe(
      false
    )
  })

  it('should put the status control between the landing and the footer when standalone', () => {
    // Arrange
    storeConsent({ crashReports: false, performance: false })

    // Act
    renderShell({ launched: false })

    // Assert
    const control = screen.getByRole('button', { name: STATUS_CONTROL_NAME })
    expect(screen.getByRole('main').contains(control)).toBe(false)
    expect(screen.getByRole('contentinfo').contains(control)).toBe(false)
  })

  it('should report the launch failure the page arrived with once telemetry starts, and only once', () => {
    // Arrange
    initConsentedTelemetryMock.mockReturnValue(true)
    setUrl(`/?launchError=${FAILED_LAUNCH}`)
    renderShell({ launched: false })

    // Act — answer, then reopen and answer again
    answerDialog({ crashReports: true, performance: false })
    fireEvent.click(screen.getByRole('button', { name: STATUS_CONTROL_NAME }))
    answerDialog({ crashReports: true, performance: true })

    // Assert
    expect(initConsentedTelemetryMock).toHaveBeenCalledTimes(2)
    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    const [reported, hint] = captureExceptionMock.mock.calls[0]
    expect(reported instanceof Error ? reported.message : reported).toContain('Failed to fetch')
    expect(hint).toStrictEqual({ tags: { source: 'launch-error' } })
  })

  it('should not report the launch failure when the answer starts no telemetry', () => {
    // Arrange — `initConsentedTelemetry` starts nothing (both switches off)
    setUrl(`/?launchError=${FAILED_LAUNCH}`)
    renderShell({ launched: false })

    // Act
    answerDialog({ crashReports: false, performance: false })

    // Assert
    expect(initConsentedTelemetryMock).toHaveBeenCalledTimes(1)
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('should tag events with the FHIR server’s host once the handshake completes', async () => {
    // Arrange
    initConsentedTelemetryMock.mockReturnValue(true)
    storeConsent({ crashReports: true, performance: false })

    // Act
    renderShell({ launched: true, children: <HandshakeProbe seen={[]} /> })

    // Assert
    await waitFor(() => {
      expect(setFhirServerHostMock).toHaveBeenCalledWith('fhir.example:8443')
    })
    expect(setFhirServerHostMock).toHaveBeenCalledTimes(1)
  })

  it('should not tag the FHIR server’s host when the answer starts no telemetry', async () => {
    // Arrange
    storeConsent({ crashReports: false, performance: false })
    const seen: QueryClient[] = []

    // Act
    renderShell({ launched: true, children: <HandshakeProbe seen={seen} /> })

    // Assert — the handshake completes, and still nothing is tagged
    await waitFor(() => {
      expect(seen[0].getQueryCache().getAll()[0]?.state.status).toBe('success')
    })
    expect(setFhirServerHostMock).not.toHaveBeenCalled()
  })

  it('should report a render error in the app, with its component stack', () => {
    // Arrange
    vi.spyOn(console, 'error').mockImplementation(() => {})
    storeConsent({ crashReports: true, performance: false })
    const renderFailure = new Error('the app failed to render')

    // Act
    renderShell({ launched: true, children: <Throws error={renderFailure} /> })

    // Assert — reported, and the boundary's fallback shown under the brand bar
    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    const [reported, hint] = captureExceptionMock.mock.calls[0]
    expect(reported).toBe(renderFailure)
    expect(hint?.extra?.componentStack).toContain('Throws')
    expect(screen.getByRole('button', { name: STATUS_CONTROL_NAME })).toBeDefined()
  })

  it('should exchange the SMART code only after the visitor answers, and exactly once', async () => {
    // Arrange — a first visit to the launched branch, under StrictMode
    const seen: QueryClient[] = []
    renderShell({ launched: true, children: <HandshakeProbe seen={seen} /> })
    expect(tokenExchangeMock).not.toHaveBeenCalled()

    // Act
    answerDialog({ crashReports: true, performance: false })

    // Assert
    await waitFor(() => {
      expect(seen[0].getQueryCache().getAll()[0]?.state.status).toBe('success')
    })
    expect(tokenExchangeMock).toHaveBeenCalledTimes(1)
  })

  it('should leave a failed handshake to be reported as the launch failure it redirects to', async () => {
    // Arrange — the app sends a failed handshake back to the root as
    // `?launchError`, where the page reports it; reporting it here as well
    // would report it twice
    initConsentedTelemetryMock.mockReturnValue(true)
    storeConsent({ crashReports: true, performance: false })
    tokenExchangeMock.mockRejectedValue(new Error('authorization code already redeemed'))
    const seen: QueryClient[] = []

    // Act
    renderShell({ launched: true, children: <HandshakeProbe seen={seen} /> })

    // Assert
    await waitFor(() => {
      expect(seen[0].getQueryCache().getAll()[0]?.state.status).toBe('error')
    })
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('should report, not throw, a FHIR server URL that does not parse, and tag no host', async () => {
    // Arrange
    initConsentedTelemetryMock.mockReturnValue(true)
    storeConsent({ crashReports: true, performance: false })
    tokenExchangeMock.mockResolvedValue(clientConnectedTo('not a url'))

    // Act
    renderShell({ launched: true, children: <HandshakeProbe seen={[]} /> })

    // Assert
    await waitFor(() => {
      expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    })
    const [reported, hint] = captureExceptionMock.mock.calls[0]
    expect(reported instanceof Error ? reported.message : reported).toContain('not a url')
    expect(hint).toStrictEqual({ tags: { source: 'fhir-server-host' } })
    expect(setFhirServerHostMock).not.toHaveBeenCalled()
  })

  it('should report a render error in the connect menu, keeping the page around it', () => {
    // Arrange
    vi.spyOn(console, 'error').mockImplementation(() => {})
    storeConsent({ crashReports: true, performance: false })
    const renderFailure = new Error('the connect menu failed to render')
    connectMenuRenderFailure.current = renderFailure

    // Act
    renderShell({ launched: false })

    // Assert — reported; the fallback sits under the app's h1, beside the
    // status control and the footer
    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    expect(captureExceptionMock.mock.calls[0][0]).toBe(renderFailure)
    expect(
      within(screen.getByRole('main')).getByRole('heading', {
        level: 2,
        name: 'Something went wrong',
      })
    ).toBeDefined()
    expect(screen.getByRole('button', { name: STATUS_CONTROL_NAME })).toBeDefined()
    expect(screen.queryByRole('contentinfo')).not.toBeNull()
  })

  describe('with a shared VITE_SENTRY_DSN in the build', () => {
    const SHARED_DSN = 'https://shared@sentry.example/1'

    it.each([
      { case: 'its own DSN', appDsn: TELEMETRY.dsn },
      { case: 'no DSN of its own', appDsn: '' },
    ])('should hand telemetry the app’s DSN when the app has $case', ({ appDsn }) => {
      // Arrange
      vi.stubEnv('VITE_SENTRY_DSN', SHARED_DSN)
      storeConsent({ crashReports: true, performance: true })

      // Act
      render(
        <SmartAppRoot
          app="medications"
          registration={REGISTRATION}
          telemetry={{ dsn: appDsn, app: TELEMETRY.app }}
          launched={false}
        >
          <div data-testid="app" />
        </SmartAppRoot>
      )

      // Assert — the per-app value wins, even empty
      expect(initConsentedTelemetryMock).toHaveBeenCalledTimes(1)
      expect(initConsentedTelemetryMock.mock.calls[0][0].config.sentry.dsn).toBe(appDsn)
    })
  })

  it('should report a failed query on the client it provides', async () => {
    // Arrange
    storeConsent({ crashReports: true, performance: false })
    const readFailure = new Error('401 Unauthorized')

    // Act
    renderShell({ launched: true, children: <FailingRead error={readFailure} /> })

    // Assert
    await waitFor(() => {
      expect(captureExceptionMock).toHaveBeenCalledWith(readFailure, { tags: { source: 'query' } })
    })
  })
})

// Helpers

/** The arrival problem the stubbed connect menu was handed, if any. */
function arrivalProblem(): string | null {
  return screen.getByTestId('connect-menu-stub').getAttribute('data-arrival-problem')
}

/** Points jsdom's location at `url` (a path plus optional query). */
function setUrl(url: string): void {
  window.history.replaceState({}, '', url)
}

/** The shell around a stub app, with the test's registration unless given another. */
function Shell({
  launched,
  registration = REGISTRATION,
}: {
  readonly launched?: boolean
  readonly registration?: typeof REGISTRATION
}): JSX.Element {
  return (
    <SmartAppRoot
      app="medications"
      registration={registration}
      telemetry={TELEMETRY}
      launched={launched}
    >
      <div data-testid="app" />
    </SmartAppRoot>
  )
}

/** Render the shell under StrictMode, as an app's `main.tsx` does. */
function renderShell({
  app = 'medications',
  launched,
  replaceLocation,
  children = <div data-testid="app" />,
}: {
  readonly app?: AppSectionId
  readonly launched?: boolean
  readonly replaceLocation?: (url: string) => void
  readonly children?: JSX.Element
}): void {
  render(
    <StrictMode>
      <SmartAppRoot
        app={app}
        registration={REGISTRATION}
        telemetry={TELEMETRY}
        launched={launched}
        replaceLocation={replaceLocation}
      >
        {children}
      </SmartAppRoot>
    </StrictMode>
  )
}

/** Stores a current answer, as a returning visitor has one. */
function storeConsent(switches: Pick<TelemetryConsent, 'crashReports' | 'performance'>): void {
  writeConsent(window.localStorage, {
    version: TELEMETRY_CONSENT_COPY.version,
    decidedAt: '2026-09-29T12:00:00.000Z',
    ...switches,
  })
}

/** Sets the dialog's switches to `switches` and presses Continue. */
function answerDialog(switches: Pick<TelemetryConsent, 'crashReports' | 'performance'>): void {
  for (const [label, wanted] of [
    [TELEMETRY_CONSENT_COPY.crashReports.label, switches.crashReports],
    [TELEMETRY_CONSENT_COPY.performance.label, switches.performance],
  ] as const) {
    const toggle = screen.getByRole<HTMLInputElement>('switch', { name: label })
    if (toggle.checked !== wanted) fireEvent.click(toggle)
  }
  fireEvent.click(screen.getByRole('button', { name: TELEMETRY_CONSENT_COPY.continueLabel }))
}

/** The consent `<dialog>` while it is open, or `null`. */
function openDialog(): HTMLDialogElement | null {
  return document.querySelector('dialog[open]')
}

/** Throws `error` from render, as a crashing app does. */
function Throws({ error }: { readonly error: Error }): never {
  throw error
}

/** Runs a query on the provided client that fails with `error`. */
function FailingRead({ error }: { readonly error: Error }): null {
  useQuery({ queryKey: ['failing-read'], queryFn: () => Promise.reject(error), retry: false })
  return null
}

/**
 * jsdom has no native `<dialog>`: `showModal` and `close` are modelled as the
 * `open` attribute, and the original descriptors are put back after each test.
 */
const dialogMethodDescriptors = (['showModal', 'close'] as const).map(
  (method) =>
    [method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method)] as const
)

function stubDialogModality(): void {
  HTMLDialogElement.prototype.showModal = function showModalByAttribute(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function closeByAttribute(this: HTMLDialogElement) {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
}

function restoreDialogModality(): void {
  for (const [method, descriptor] of dialogMethodDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, method)
    else Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
  }
}

/** A ready fhirclient `Client` connected to `serverUrl`. */
function clientConnectedTo(serverUrl: string): Client {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub; the root reads only `state.serverUrl`
  return { state: { serverUrl } } as unknown as Client
}

/** Starts the SMART handshake and records the client it was provided. */
function HandshakeProbe({ seen }: { readonly seen: QueryClient[] }): null {
  seen.push(useQueryClient())
  useSmartHandshake()
  return null
}
