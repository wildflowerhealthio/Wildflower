import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import type { FakeFhirServer } from '../fake-fhir-server.test-helpers.ts'
import {
  END_TO_END_TIMEOUT_MILLIS,
  endLiftingTest,
  PATIENT_ID,
  seedStartedLifter,
  seedWorkout,
  startLiftingTest,
} from '../lifting-app.test-helpers.ts'
import { SEARCH_CONCURRENCY } from './read-every-page.ts'
import { readTrainingRecord } from './training-record.ts'
import { readWorkoutHistory } from './workout-history.ts'

/**
 * The cap on a client's searches, over the in-memory FHIR server (see
 * `fake-fhir-server.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startLiftingTest()
})

afterEach(endLiftingTest)

describe('SEARCH_CONCURRENCY', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should cap the training record and the history together when they read side by side', async () => {
    // Arrange — five lifts and three completed workouts: more searches than the cap
    seedStartedLifter(server)
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })
    const client = server.clientFor(PATIENT_ID)

    // Act
    await Effect.runPromise(
      Effect.all([readTrainingRecord(client, PATIENT_ID), readWorkoutHistory(client, PATIENT_ID)], {
        concurrency: 'unbounded',
      })
    )

    // Assert
    expect(server.searches.length).toBeGreaterThan(2 * SEARCH_CONCURRENCY)
    expect(server.mostSearchesInFlight()).toBe(SEARCH_CONCURRENCY)
  })
})
