import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  type FakeFhirServer,
  resourceTypeOfQuery,
  searchParamsOf,
} from '../../fake-fhir-server.test-helpers.ts'
import {
  END_TO_END_TIMEOUT_MILLIS,
  endStrengthTest,
  mountStrengthApp,
  seedStartedLifter,
  seedWorkout,
  startStrengthTest,
  tabLink,
} from '../../strength-app.test-helpers.ts'

/**
 * The History tab: completed workouts read and listed, driven through
 * the app's router over the in-memory FHIR server (see
 * `strength-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startStrengthTest()
})

afterEach(endStrengthTest)

describe('HistoryTab', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should list a completed workout in the history, read with closed requests', async () => {
    // Arrange — one workout done, every lift met
    const user = userEvent.setup()
    seedStartedLifter(server)
    seedWorkout(server, { squat: [5, 5, 5, 5, 5], 'bench-press': [5, 5, 5, 5, 5] })
    mountStrengthApp(server)
    await screen.findByRole('heading', { name: 'Workout B' })

    // Act
    await user.click(tabLink('History'))

    // Assert
    expect(await screen.findByText(/^Workout A · /)).toBeDefined()
    const serviceRequestSearches = server.searches
      .filter((query) => resourceTypeOfQuery(query) === 'ServiceRequest')
      .map(searchParamsOf)
    expect(serviceRequestSearches.some((params) => !params.has('status'))).toBe(true)
  })
})
