import { UrlParams } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as SmartModule from '@wildflowerhealthio/fhir-r4-react/smart'
import type { SmartHandshake } from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  answerJson,
  answerStatus,
  bundleOf,
  neverAnswer,
  stubFhirServer,
  type StubAnswer,
  type StubFhirServer,
} from '@wildflowerhealthio/fhir-r4-react/smart/test-helpers'
import type { PebbleSettings } from '@wildflowerhealthio/fhir-sync-pebble-core'
import { ReturnTarget, type ReturnTargetStore } from '@wildflowerhealthio/pebble-configuration'
import { Either, Option } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

/**
 * The app's own wiring. `App` is driven through a stubbed handshake; everything
 * past the handshake runs through `SettingsApp` over the real
 * `buildSmartRouterContext` with only the transport stubbed, so the patient
 * search goes through the router context and the SMART HTTP layer exactly as
 * in production — and what reaches the wire is asserted here, because no test
 * one layer down can see it.
 */

// The handshake is driven per test, and the runtime the gate builds goes out
// over a stub server that answers nothing.
const { handshakeMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
}))
vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => {
  const actual = await importOriginal<typeof SmartModule>()
  return {
    ...actual,
    useSmartHandshake: () => handshakeMock(),
    useRedirectToRootOnFailure: (): void => undefined,
    smartRuntimeFor: (
      connection: SmartModule.SmartConnection,
      transport = stubFhirServer({}).transport
    ) => actual.smartRuntimeFor(connection, transport),
  }
})

const {
  buildSmartRouterContext,
  decodeFhirBaseUrl,
  RootArrival,
  SmartConnection,
  SmartHandshake: SmartHandshakeOf,
  smartRuntimeFor,
} = await import('@wildflowerhealthio/fhir-r4-react/smart')
const { SignInLandingContext } = await import('@wildflowerhealthio/smart-app-react')
const { App, SettingsApp } = await import('./app.tsx')

const SERVER_URL = 'https://fhir.example/r4'
const ACCESS_TOKEN = 'watch-token'

/** The stub server the last {@link mount} read from. */
let mountedServer: StubFhirServer | undefined

/** Every request the mounted server was sent, in order. */
const recorded = (): {
  readonly url: string
  readonly urlParams: string
  readonly authorization: string | undefined
}[] =>
  (mountedServer?.requests ?? []).map((request) => ({
    url: request.url,
    urlParams: UrlParams.toString(request.urlParams),
    authorization: request.headers['authorization'],
  }))

beforeEach(() => {
  mountedServer = undefined
  handshakeMock.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('App', () => {
  it('should show the connecting state while the handshake is in flight', () => {
    // Arrange
    handshakeMock.mockReturnValue(SmartHandshakeOf.Connecting())

    // Act
    renderApp()

    // Assert
    expect(screen.getByText('Connecting…')).toBeDefined()
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it("should take the settings page's refusal from what the grant lacked", async () => {
    // Arrange — the server completed the handshake without an access token
    handshakeMock.mockReturnValue(
      SmartHandshakeOf.Ready({ connection: grantedConnection({ accessToken: Option.none() }) })
    )

    // Act
    renderApp()

    // Assert
    expect(
      await screen.findByRole('heading', { level: 1, name: 'FHIR Sync for Pebble' })
    ).toBeDefined()
    expect(screen.getByText(/did not grant an access token/)).toBeDefined()
  })
})

describe('SettingsApp', () => {
  it("should search the server's patients on the FHIR server the handshake named, with the granted token", async () => {
    // Act
    mount({ server: serving([ADA, GRACE]) })
    await openPicker()

    // Assert
    expect(recorded()).toEqual([
      {
        url: `${SERVER_URL}/Patient`,
        urlParams: '_sort=family&_count=200',
        authorization: `Bearer ${ACCESS_TOKEN}`,
      },
    ])
  })

  it('should list each patient the server returned, by name', async () => {
    // Act
    mount({ server: serving([ADA, GRACE]) })
    await openPicker()

    // Assert
    expect(screen.getByRole('option', { name: /Ada Lovelace/ })).toBeDefined()
    expect(screen.getByRole('option', { name: /Grace Hopper/ })).toBeDefined()
  })

  it('should send the picked patient back to the Pebble app on save', async () => {
    // Arrange
    const user = userEvent.setup()
    const navigate = vi.fn<(url: string) => void>()
    mount({ server: serving([ADA, GRACE]), returnTo: 'http://localhost:61234/close?', navigate })
    await openPicker()

    // Act
    await user.click(screen.getByRole('option', { name: /Ada Lovelace/ }))
    await user.click(screen.getByRole('button', { name: 'Save to watch' }))

    // Assert
    expect(navigate).toHaveBeenCalledWith(
      'http://localhost:61234/close?' +
        encodeURIComponent(
          JSON.stringify({
            patientId: 'ada',
            patientName: 'Ada Lovelace',
            patientBirthDate: '1815-12-10',
            accessToken: ACCESS_TOKEN,
            fhirBaseUrl: SERVER_URL,
          })
        )
    )
  })

  it('should switch to another patient in the page, without signing in again', async () => {
    // Arrange
    const user = userEvent.setup()
    const navigate = vi.fn<(url: string) => void>()
    mount({ server: serving([ADA, GRACE]), navigate })
    await openPicker()
    await user.click(screen.getByRole('option', { name: /Ada Lovelace/ }))

    // Act
    await user.click(screen.getByRole('button', { name: /Ada Lovelace/ }))
    await user.click(screen.getByRole('option', { name: /Grace Hopper/ }))
    await user.click(screen.getByRole('button', { name: 'Save to watch' }))

    // Assert
    expect(handedOffSettings(navigate)).toMatchObject({
      patientId: 'grace',
      patientName: 'Grace Hopper',
    })
    expect(recorded()).toHaveLength(1)
  })

  it('should list and hand off a patient whose birth date is only a year', async () => {
    // Arrange — `fhir-r4`'s strict `Patient` schema refuses a partial date
    const user = userEvent.setup()
    const navigate = vi.fn<(url: string) => void>()
    mount({
      server: serving([
        { resourceType: 'Patient', id: 'year', name: [{ text: 'Y. Only' }], birthDate: '1970' },
      ]),
      navigate,
    })
    await openPicker()

    // Act
    await user.click(screen.getByRole('option', { name: /Y\. Only/ }))
    await user.click(screen.getByRole('button', { name: 'Save to watch' }))

    // Assert
    expect(handedOffSettings(navigate)).toMatchObject({
      patientId: 'year',
      patientBirthDate: '1970',
    })
  })

  it('should leave out an entry it cannot read and list the rest', async () => {
    // Act — the first entry has no id
    mount({ server: serving([{ resourceType: 'Patient', name: [{ text: 'No id' }] }, ADA]) })
    await openPicker()

    // Assert
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Ada Lovelaceada',
    ])
  })

  it('should hold the save until a patient is picked', async () => {
    // Act
    mount({ server: serving([ADA]) })

    // Assert
    await screen.findByRole('button', { name: 'Select a Patient' })
    expect(screen.getByRole('button', { name: 'Save to watch' }).hasAttribute('disabled')).toBe(
      true
    )
  })

  it('should hold the save while the patients are being read', async () => {
    // Act — the server never answers
    mount({ server: neverAnswer })

    // Assert
    expect(await screen.findByText("Reading the server's patients…")).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save to watch' }).hasAttribute('disabled')).toBe(
      true
    )
  })

  it('should say so, and offer no pick, when the server has no patients', async () => {
    // Act
    mount({ server: serving([]) })

    // Assert
    expect(await screen.findByText(/has no patients to choose from/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Select a Patient' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save to watch' }).hasAttribute('disabled')).toBe(
      true
    )
  })

  it('should show the failure, and block the save, when the granted token cannot search patients', async () => {
    // Act
    mount({ server: answerStatus(403, {}) })

    // Assert
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Select a Patient' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save to watch' }).hasAttribute('disabled')).toBe(
      true
    )
  })
})

// Helpers

const ADA = {
  resourceType: 'Patient',
  id: 'ada',
  name: [{ given: ['Ada'], family: 'Lovelace' }],
  birthDate: '1815-12-10',
}

const GRACE = {
  resourceType: 'Patient',
  id: 'grace',
  name: [{ given: ['Grace'], family: 'Hopper' }],
  birthDate: '1906-12-09',
}

/** A server whose `Patient` search returns `patients`. */
const serving = (patients: readonly unknown[]): StubAnswer => answerJson(bundleOf(patients))

/** Opens the patient picker once the list has been read. */
const openPicker = async (): Promise<void> => {
  await userEvent.click(await screen.findByRole('button', { name: 'Select a Patient' }))
}

/** The settings JSON `navigate` was last handed, parsed back. */
const handedOffSettings = (navigate: ReturnType<typeof vi.fn<(url: string) => void>>): unknown => {
  const url = navigate.mock.lastCall?.[0] ?? ''
  return JSON.parse(decodeURIComponent(url.slice(ReturnTarget.DEFAULT.length)))
}

/** Mounts `SettingsApp` for the granted token against `server`. */
const mount = ({
  server,
  returnTo = ReturnTarget.DEFAULT,
  navigate = (): void => undefined,
}: {
  readonly server: StubAnswer
  readonly returnTo?: string
  readonly navigate?: (url: string) => void
}): void => {
  mountedServer = stubFhirServer({ [SERVER_URL]: server })
  const context = buildSmartRouterContext(
    smartRuntimeFor(
      grantedConnection({ accessToken: Option.some(ACCESS_TOKEN) }),
      mountedServer.transport
    ),
    new QueryClient({ defaultOptions: { queries: { retry: false } } })
  )
  const returnTargets: ReturnTargetStore.Store = {
    rememberFrom: (): void => undefined,
    recall: () => ReturnTarget.decode(returnTo),
  }
  render(
    <SettingsApp
      context={context}
      connection={Either.right({
        accessToken: ACCESS_TOKEN,
        fhirBaseUrl: SERVER_URL,
      } satisfies PebbleSettings.Connection)}
      returnTargets={returnTargets}
      navigate={navigate}
    />
  )
}

/** Renders `App` under a retry-free query client. */
const renderApp = (): void => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SignInLandingContext
        value={{
          arrival: RootArrival.SignInReturn({ code: 'abc', state: 'xyz' }),
          registration: { clientId: 'fhir-sync-pebble', scope: 'launch' },
          appRootRedirectUri: `${window.location.origin}/`,
          onSignedIn: () => undefined,
        }}
      >
        <App />
      </SignInLandingContext>
    </QueryClientProvider>
  )
}

/** A connection to {@link SERVER_URL} carrying what the server granted. */
const grantedConnection = ({
  accessToken,
}: {
  readonly accessToken: Option.Option<string>
}): SmartModule.SmartConnection =>
  new SmartConnection({
    fhirBaseUrl: decodeFhirBaseUrl(SERVER_URL),
    accessToken,
    launchPatientId: Option.none(),
    grantedScopes: [],
  })
