import type { HttpClient } from '@effect/platform'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as FhirR4ReactSmart from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  RootArrival,
  SmartHandshake,
  type SignInLanding,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { SignInLandingContext } from '@wildflowerhealthio/smart-app-react'
import type { Layer } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { type FakeFhirServer, resourceTypeOfQuery } from './fake-fhir-server.test-helpers.ts'
import type * as RouterModule from './router.ts'
import {
  BASEPATH,
  currentRoute,
  END_TO_END_TIMEOUT_MILLIS,
  endStrengthTest,
  openTestPage,
  PATIENT_ID,
  renderWithQueryClient,
  seedStartedLifter,
  startStrengthTest,
} from './strength-app.test-helpers.ts'

// The handshake is driven per test, and the runtime the gate builds goes out
// over the test's in-memory server rather than `fetch`.
const { handshakeMock, serverTransport } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
  serverTransport: { current: undefined as Layer.Layer<HttpClient.HttpClient> | undefined },
}))
vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => {
  const actual = await importOriginal<typeof FhirR4ReactSmart>()
  return {
    ...actual,
    useSmartHandshake: () => handshakeMock(),
    useRedirectToRootOnFailure: (): void => undefined,
    smartRuntimeFor: (
      connection: FhirR4ReactSmart.SmartConnection,
      transport = serverTransport.current
    ) => actual.smartRuntimeFor(connection, transport),
  }
})

// The router builder, spied on, so a test can tell the router outlives a
// patient change.
vi.mock('./router.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof RouterModule>()
  return { buildRouter: vi.fn(actual.buildRouter) }
})

const { App } = await import('./app.tsx')
const { buildRouter } = await import('./router.ts')

/**
 * `App`: where a completed launch lands — its patient's page, or the picker
 * — and the picker's navigations, over the in-memory FHIR server (see
 * `strength-app.test-helpers.ts`). The SMART handshake (which needs a browser
 * redirect) and `useRedirectToRootOnFailure` (which would navigate away) are
 * stubbed.
 */

let server: FakeFhirServer

/** The sign-in the app root hands the app: a return to {@link BASEPATH}. */
const SIGN_IN_LANDING: SignInLanding = {
  arrival: RootArrival.SignInReturn({ code: 'abc', state: 'xyz' }),
  registration: { clientId: 'strength', scope: 'launch' },
  appRootRedirectUri: `${window.location.origin}${BASEPATH}`,
  onSignedIn: () => undefined,
}

/** Render `App` on the sign-in landing the app root would hand it. */
const renderApp = (): void => {
  renderWithQueryClient(
    <SignInLandingContext value={SIGN_IN_LANDING}>
      <App page={openTestPage()} />
    </SignInLandingContext>
  )
}

beforeEach(() => {
  server = startStrengthTest()
  serverTransport.current = server.transport
  window.history.replaceState(null, '', BASEPATH)
})

afterEach(() => {
  endStrengthTest()
  handshakeMock.mockReset()
  vi.mocked(buildRouter).mockClear()
})

describe('App', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should open the patient picker when the launch names no patient, reading no record', async () => {
    // Arrange
    handshakeMock.mockReturnValue(SmartHandshake.Ready({ connection: server.connectionFor(null) }))

    // Act
    renderApp()

    // Assert — the picker's own path, and only patients are searched
    expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /All patients/ })).toBeDefined()
    expect(currentRoute()).toBe('patients')
    expect(server.searches.map(resourceTypeOfQuery)).toEqual(['Patient'])
    expect(server.writes).toEqual([])
  })

  it('should open the lifter picked on their Today', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    handshakeMock.mockReturnValue(SmartHandshake.Ready({ connection: server.connectionFor(null) }))
    renderApp()

    // Act
    await user.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(currentRoute()).toBe(`patients/${PATIENT_ID}/today`)
  })

  it('should open the launch’s patient on their Today, in the app root’s place', async () => {
    // Arrange
    seedStartedLifter(server)
    handshakeMock.mockReturnValue(
      SmartHandshake.Ready({ connection: server.connectionFor(PATIENT_ID) })
    )
    const historyLength = window.history.length

    // Act
    renderApp()

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Wildflower Strength', level: 1 })).toBeDefined()
    expect(currentRoute()).toBe(`patients/${PATIENT_ID}/today`)
    expect(window.history.length).toBe(historyLength)
  })

  it('should push the picker on Change patient, closing it on Back', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    handshakeMock.mockReturnValue(
      SmartHandshake.Ready({ connection: server.connectionFor(PATIENT_ID) })
    )
    renderApp()
    await screen.findByRole('heading', { name: 'Workout A' })

    // Act
    await user.click(screen.getByRole('button', { name: 'Change patient' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
    expect(currentRoute()).toBe('patients')

    // Act
    window.history.back()

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(currentRoute()).toBe(`patients/${PATIENT_ID}/today`)
    expect(screen.queryByRole('heading', { name: 'Choose a patient' })).toBeNull()
  })

  it("should open every patient's workouts on All patients, in the same router, and step Back through the picker", async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    handshakeMock.mockReturnValue(
      SmartHandshake.Ready({ connection: server.connectionFor(PATIENT_ID) })
    )
    renderApp()
    await screen.findByRole('heading', { name: 'Workout A' })
    const routersBuilt = vi.mocked(buildRouter).mock.calls.length

    // Act
    await user.click(screen.getByRole('button', { name: 'Change patient' }))
    await user.click(await screen.findByRole('button', { name: /All patients/ }))

    // Assert — no new router
    await waitFor(() => {
      expect(currentRoute()).toBe('workouts')
    })
    expect(screen.getByText('All patients')).toBeDefined()
    expect(vi.mocked(buildRouter).mock.calls).toHaveLength(routersBuilt)

    // Act — Back to the picker's entry
    window.history.back()

    // Assert
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()

    // Act — Back past it
    window.history.back()

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(currentRoute()).toBe(`patients/${PATIENT_ID}/today`)
    expect(screen.getByText('Ada Lovelace · born 1990-01-01')).toBeDefined()
  })
})
