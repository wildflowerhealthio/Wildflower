import type { HttpClient } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type * as SmartReads from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  CallbackStateMismatch,
  RootArrival,
  SmartHandshake,
  type SignInLanding,
  type SmartConnection,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  answerJson,
  bundleOf,
  STUB_FHIR_BASE,
  stubConnection,
  stubFhirServer,
  type StubAnswers,
  type StubFhirServer,
} from '@wildflowerhealthio/fhir-r4-react/smart/test-helpers'
import { SignInLandingContext } from '@wildflowerhealthio/smart-app-react'
import { type Layer, Option } from 'effect'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

// Only the handshake is stubbed: the patient reads are the real
// `fhir-r4-react/smart` ones, on the runtime the real gate builds, over a stub
// transport that answers from a table of FHIR responses.
const { handshakeMock, launchFailureRedirectMock, launchTransport } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
  launchFailureRedirectMock: vi.fn<(handshake: SmartHandshake) => void>(),
  launchTransport: { current: undefined as Layer.Layer<HttpClient.HttpClient> | undefined },
}))
vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => {
  const actual: typeof SmartReads = await importOriginal()
  return {
    ...actual,
    useSmartHandshake: () => handshakeMock(),
    useRedirectToRootOnFailure: (handshake: SmartHandshake) => {
      launchFailureRedirectMock(handshake)
    },
    smartRuntimeFor: (connection: SmartConnection, transport = launchTransport.current) =>
      actual.smartRuntimeFor(connection, transport),
  }
})

const { App } = await import('./app.tsx')

/** The stub servers the test's launches read from, each recording what it was sent. */
const stubServers: StubFhirServer[] = []

/**
 * A completed handshake with `patientId` in context, whose reads answer from
 * `responses`. A request no entry answers dies, as a test that forgot a
 * response.
 */
const launchWith = (patientId: string | null, responses: StubAnswers): void => {
  const server = stubFhirServer(responses)
  stubServers.push(server)
  launchTransport.current = server.transport
  handshakeMock.mockReturnValue(
    SmartHandshake.Ready({
      connection: stubConnection({ launchPatientId: Option.fromNullable(patientId) }),
    })
  )
}

const patientWire = {
  resourceType: 'Patient',
  id: 'p1',
  name: [{ given: ['Ada'], family: 'Lovelace' }],
  birthDate: '1815-12-10',
}

const otherPatientWire = {
  resourceType: 'Patient',
  id: 'p2',
  name: [{ given: ['Grace'], family: 'Hopper' }],
  birthDate: '1906-12-09',
}

/** The server's two patients: each by id, and both on the picker's list. */
const patientResponses: StubAnswers = {
  'Patient/p1': answerJson(patientWire),
  'Patient/p2': answerJson(otherPatientWire),
  'Patient?': answerJson(bundleOf([patientWire, otherPatientWire])),
}

/** The sign-in the app root hands the app: a return to the app root. */
const SIGN_IN_LANDING: SignInLanding = {
  arrival: RootArrival.SignInReturn({ code: 'abc', state: 'xyz' }),
  registration: { clientId: 'assistant', scope: 'launch' },
  appRootRedirectUri: `${window.location.origin}/`,
  onSignedIn: () => undefined,
}

/**
 * Render `App` under StrictMode over a retry-free client (fast failures), on
 * the sign-in landing the app root would hand it.
 */
const renderApp = (): void => {
  render(
    <StrictMode>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <SignInLandingContext value={SIGN_IN_LANDING}>
          <App />
        </SignInLandingContext>
      </QueryClientProvider>
    </StrictMode>
  )
}

/** The `patient` the URL holds, as `usePatientChoice` wrote it. */
const patientInUrl = (): string | null => new URLSearchParams(window.location.search).get('patient')

/** Every patient read the app issued, as the path and query after the FHIR base. */
const patientReads = (): readonly string[] =>
  stubServers
    .flatMap((server) => server.urls)
    .filter((url) => url.startsWith(`${STUB_FHIR_BASE}/Patient`))
    .map((url) => url.slice(STUB_FHIR_BASE.length + 1))

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  stubServers.length = 0
})

afterEach(() => {
  cleanup()
  handshakeMock.mockReset()
  launchFailureRedirectMock.mockReset()
})

describe('App', () => {
  it('should say Loading… under the title while the handshake is still connecting', () => {
    // Arrange
    handshakeMock.mockReturnValue(SmartHandshake.Connecting())

    // Act
    renderApp()

    // Assert
    expect(screen.getByRole('heading', { level: 1, name: 'Wildflower Assistant' })).toBeDefined()
    expect(screen.getByText('Loading…')).toBeDefined()
  })

  it('should surface a failed token exchange under the title and carry it to the app root', () => {
    // Arrange
    handshakeMock.mockReturnValue(
      SmartHandshake.Failed({
        error: new CallbackStateMismatch({ reason: 'token exchange failed' }),
      })
    )

    // Act
    renderApp()

    // Assert
    expect(screen.getByRole('heading', { level: 1, name: 'Wildflower Assistant' })).toBeDefined()
    expect(screen.getByRole('alert').textContent).toContain('token exchange failed')
    const [carried] = launchFailureRedirectMock.mock.calls[0] ?? []
    expect(carried?._tag).toBe('Failed')
  })

  it("should open on the launch's patient, named under the title over the empty page", async () => {
    // Arrange
    launchWith('p1', patientResponses)

    // Act
    renderApp()

    // Assert
    expect(await screen.findByText('Ada Lovelace · born 1815-12-10')).toBeDefined()
    expect(screen.getByText('Chat comes next.')).toBeDefined()
    expect(screen.queryByRole('button', { name: /All patients/ })).toBeNull()
  })

  it("should open on the URL's patient over the launch's", async () => {
    // Arrange
    window.history.replaceState(null, '', '/?patient=p2')
    launchWith('p1', patientResponses)

    // Act
    renderApp()

    // Assert
    expect(await screen.findByText('Grace Hopper · born 1906-12-09')).toBeDefined()
    expect(patientReads()).not.toContain('Patient/p1')
  })

  it('should offer a patient picker with no patient in context, and write the choice to the URL', async () => {
    // Arrange
    launchWith(null, patientResponses)
    renderApp()
    expect(screen.queryByText('Chat comes next.')).toBeNull()

    // Act
    fireEvent.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))

    // Assert
    expect(patientInUrl()).toBe('p1')
    expect(await screen.findByText('Ada Lovelace · born 1815-12-10')).toBeDefined()
    expect(screen.getByText('Chat comes next.')).toBeDefined()
  })

  it('should offer All patients on the picker, and name it under the title once chosen', async () => {
    // Arrange
    launchWith(null, patientResponses)
    renderApp()

    // Act
    fireEvent.click(await screen.findByRole('button', { name: /All patients/ }))

    // Assert
    expect(patientInUrl()).toBe('*')
    expect(await screen.findByText('All patients')).toBeDefined()
    expect(screen.getByText('Chat comes next.')).toBeDefined()
  })

  it("should change from the launch's patient to another from the picker", async () => {
    // Arrange
    launchWith('p1', patientResponses)
    renderApp()
    await screen.findByText('Ada Lovelace · born 1815-12-10')

    // Act
    fireEvent.click(screen.getByRole('button', { name: 'Change patient' }))
    fireEvent.click(await screen.findByRole('button', { name: /Grace Hopper/ }))

    // Assert
    expect(await screen.findByText('Grace Hopper · born 1906-12-09')).toBeDefined()
    expect(patientInUrl()).toBe('p2')
  })
})
