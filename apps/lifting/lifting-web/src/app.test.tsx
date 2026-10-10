import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as FhirR4ReactSmart from '@wildflowerhealthio/fhir-r4-react/smart'
import type { SmartHandshake } from '@wildflowerhealthio/fhir-r4-react/smart'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { type FakeFhirServer, resourceTypeOfQuery } from './fake-fhir-server.test-helpers.ts'
import {
  END_TO_END_TIMEOUT_MILLIS,
  endLiftingTest,
  PATIENT_ID,
  renderWithQueryClient,
  seedStartedLifter,
  startLiftingTest,
} from './lifting-app.test-helpers.ts'

const { handshakeMock } = vi.hoisted(() => ({
  handshakeMock: vi.fn<() => SmartHandshake>(),
}))
vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof FhirR4ReactSmart>()),
  useSmartHandshake: () => handshakeMock(),
  useLaunchFailureRedirect: (): void => undefined,
}))

const { App } = await import('./app.tsx')

/**
 * `App`: the patient chosen — the URL's, the launch's, or the picker's —
 * decides what mounts, over the in-memory FHIR server (see
 * `lifting-app.test-helpers.ts`). The SMART handshake (which needs a browser
 * redirect) and `useLaunchFailureRedirect` (which would navigate away) are
 * stubbed.
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startLiftingTest()
  window.history.replaceState(null, '', '/lifting/')
})

afterEach(() => {
  endLiftingTest()
  handshakeMock.mockReset()
})

describe('App', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should offer the patient picker when the launch names no patient, reading no record', async () => {
    // Arrange
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(null) })

    // Act
    renderWithQueryClient(<App />)

    // Assert — only patients are searched
    expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /All patients/ })).toBeDefined()
    expect(server.searches.map(resourceTypeOfQuery)).toEqual(['Patient'])
    expect(server.writes).toEqual([])
  })

  it('should mount the lifting screens for the patient picked, and write the pick to the URL', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(null) })
    renderWithQueryClient(<App />)

    // Act
    await user.click(await screen.findByRole('button', { name: /Ada Lovelace/ }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(new URLSearchParams(window.location.search).get('patient')).toBe(PATIENT_ID)
  })

  it('should go back to the picker on Change patient', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(PATIENT_ID) })
    renderWithQueryClient(<App />)
    await screen.findByRole('heading', { name: 'Workout A' })

    // Act
    await user.click(screen.getByRole('button', { name: 'Change patient' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Choose a patient' })).toBeDefined()
  })

  it('should mount the lifting screens for the patient the launch names', async () => {
    // Arrange
    seedStartedLifter(server)
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(PATIENT_ID) })

    // Act
    renderWithQueryClient(<App />)

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Lifting', level: 1 })).toBeDefined()
  })
})
