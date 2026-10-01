import { screen } from '@testing-library/react'
import type * as FhirR4ReactSmart from 'fhir-r4-react/smart'
import type { SmartHandshake } from 'fhir-r4-react/smart'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { FakeFhirServer } from './fake-fhir-server.test-helpers.ts'
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
vi.mock('fhir-r4-react/smart', async (importOriginal) => ({
  ...(await importOriginal<typeof FhirR4ReactSmart>()),
  useSmartHandshake: () => handshakeMock(),
  useLaunchFailureRedirect: (): void => undefined,
}))

const { App } = await import('./app.tsx')

/**
 * `App`: the handshake's patient decides what mounts, over the in-memory FHIR
 * server (see `lifting-app.test-helpers.ts`). The SMART handshake (which needs
 * a browser redirect) and `useLaunchFailureRedirect` (which would navigate
 * away) are stubbed.
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startLiftingTest()
})

afterEach(() => {
  endLiftingTest()
  handshakeMock.mockReset()
})

describe('App', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should stop at a gate when the launch names no patient, reading and writing nothing', () => {
    // Arrange
    handshakeMock.mockReturnValue({ kind: 'ready', client: server.clientFor(null) })

    // Act
    renderWithQueryClient(<App />)

    // Assert
    expect(screen.getByText('Lifting needs a patient')).toBeDefined()
    expect(server.searches).toEqual([])
    expect(server.writes).toEqual([])
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
