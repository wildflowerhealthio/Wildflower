import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as FhirR4ReactSmart from '@wildflowerhealthio/fhir-r4-react/smart'
import type { SmartHandshake } from '@wildflowerhealthio/fhir-r4-react/smart'
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

const { handshakeMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
}))
vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof FhirR4ReactSmart>()),
  useSmartHandshake: () => handshakeMock(),
  useLaunchFailureRedirect: (): void => undefined,
}))

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
 * redirect) and `useLaunchFailureRedirect` (which would navigate away) are
 * stubbed.
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startStrengthTest()
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
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(null) })

    // Act
    renderWithQueryClient(<App page={openTestPage()} />)

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
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(null) })
    renderWithQueryClient(<App page={openTestPage()} />)

    // Act
    await user.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(currentRoute()).toBe(`patients/${PATIENT_ID}/today`)
  })

  it('should open the launch’s patient on their Today, in the app root’s place', async () => {
    // Arrange
    seedStartedLifter(server)
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(PATIENT_ID) })
    const historyLength = window.history.length

    // Act
    renderWithQueryClient(<App page={openTestPage()} />)

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Strength', level: 1 })).toBeDefined()
    expect(currentRoute()).toBe(`patients/${PATIENT_ID}/today`)
    expect(window.history.length).toBe(historyLength)
  })

  it('should push the picker on Change patient, closing it on Back', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(PATIENT_ID) })
    renderWithQueryClient(<App page={openTestPage()} />)
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
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(PATIENT_ID) })
    renderWithQueryClient(<App page={openTestPage()} />)
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
