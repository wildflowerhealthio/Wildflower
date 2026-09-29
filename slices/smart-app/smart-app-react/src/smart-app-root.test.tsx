import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  APP_DESCRIPTIONS,
  APP_SECTION_IDS,
  TELEMETRY_CONSENT_COPY,
  type AppSectionId,
} from 'branding-core'
import type Client from 'fhirclient/lib/Client'
import { StrictMode, type JSX } from 'react'
import { type TelemetryConsent, writeConsent } from 'telemetry-core'
import type * as TelemetryWeb from 'telemetry-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { encodeLaunchError, useSmartHandshake } from 'fhir-r4-react/smart'

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
// it resolves to a client connected to `FHIR_SERVER_URL`.
const FHIR_SERVER_URL = 'https://fhir.example:8443/r4'
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only stub; the root reads only `state.serverUrl`
const readyClient = { state: { serverUrl: FHIR_SERVER_URL } } as unknown as Client
vi.mock('fhirclient', () => ({
  default: { oauth2: { ready: () => Promise.resolve(readyClient) } },
}))

// The stub echoes the props it was handed as data attributes so the wiring
// (the SMART target, `clientId` / `scope` from the `standalone` prop,
// `redirectUri` from the URL, the latched launch failure as `arrivalProblem`)
// is observable. The branding chrome renders for real; the menu's own banner is
// `connect-menu.test.tsx`'s.
vi.mock('./connect-menu.tsx', () => ({
  ConnectMenu: (props: ConnectMenuProps) => (
    <div
      data-testid="connect-menu-stub"
      data-target={props.target}
      data-client-id={props.target === 'fhir-r4' ? props.clientId : undefined}
      data-scope={props.target === 'fhir-r4' ? props.scope : undefined}
      data-redirect-uri={props.target === 'fhir-r4' ? props.redirectUri : undefined}
      data-arrival-problem={
        props.arrivalProblem instanceof Error ? props.arrivalProblem.message : props.arrivalProblem
      }
    />
  ),
}))

const STANDALONE = {
  clientId: 'medications-app',
  scope: 'launch openid fhirUser system/MedicationRequest.rs',
}

const TELEMETRY: SmartAppTelemetry = {
  dsn: 'https://key@sentry.example/42',
  app: 'medications-app',
}

const MARKETING_ORIGIN = 'https://wildflowerhealth.io/'

const STATUS_CONTROL_NAME = /change telemetry settings/

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

  it('should hand the connect menu the SMART target, the standalone config and this root as its redirect', () => {
    // Arrange — served from a subpath, with a query that must not leak into the redirect
    setUrl('/importer-app/index.html?utm_source=email')

    // Act
    renderShell({ launched: false })

    // Assert
    const menu = screen.getByTestId('connect-menu-stub')
    expect(menu.getAttribute('data-target')).toBe('fhir-r4')
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
        <SmartAppRoot app="medications" standalone={STANDALONE} telemetry={TELEMETRY} launched>
          <HandshakeProbe seen={seen} />
        </SmartAppRoot>
      </StrictMode>
    )
    rerender(
      <StrictMode>
        <SmartAppRoot app="medications" standalone={STANDALONE} telemetry={TELEMETRY} launched>
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

/** The shell around a stub app, with the test's standalone config. */
function Shell({ launched }: { readonly launched?: boolean }): JSX.Element {
  return (
    <SmartAppRoot
      app="medications"
      standalone={STANDALONE}
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
  children = <div data-testid="app" />,
}: {
  readonly app?: AppSectionId
  readonly launched?: boolean
  readonly children?: JSX.Element
}): void {
  render(
    <StrictMode>
      <SmartAppRoot app={app} standalone={STANDALONE} telemetry={TELEMETRY} launched={launched}>
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

/** Starts the SMART handshake and records the client it was provided. */
function HandshakeProbe({ seen }: { readonly seen: QueryClient[] }): null {
  seen.push(useQueryClient())
  useSmartHandshake()
  return null
}
