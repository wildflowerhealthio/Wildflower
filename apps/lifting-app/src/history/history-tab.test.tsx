import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  type FakeFhirServer,
  resourceTypeOfQuery,
  searchParamsOf,
} from '../fake-fhir-server.test-helpers.ts'
import {
  END_TO_END_TIMEOUT_MILLIS,
  endLiftingTest,
  mountLiftingApp,
  seedStartedLifter,
  seedWorkout,
  startLiftingTest,
} from '../lifting-app.test-helpers.ts'

/**
 * The History tab: completed workouts read and listed, driven through
 * `LiftingApp` over the in-memory FHIR server (see
 * `lifting-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startLiftingTest()
})

afterEach(endLiftingTest)

describe('HistoryTab', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should list a completed workout in the history, read with closed requests', async () => {
    // Arrange — one workout done, every lift met
    const user = userEvent.setup()
    seedStartedLifter(server)
    seedWorkout(server, { squat: [5, 5, 5, 5, 5], 'bench-press': [5, 5, 5, 5, 5] })
    mountLiftingApp(server)
    await screen.findByRole('heading', { name: 'Workout B' })

    // Act
    await user.click(screen.getByRole('button', { name: 'History' }))

    // Assert
    expect(await screen.findByText(/^Workout A · /)).toBeDefined()
    const serviceRequestSearches = server.searches
      .filter((query) => resourceTypeOfQuery(query) === 'ServiceRequest')
      .map(searchParamsOf)
    expect(serviceRequestSearches.some((params) => !params.has('status'))).toBe(true)
  })
})
