import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  type FakeFhirServer,
  resourceTypeOfQuery,
  searchParamsOf,
} from '../fake-fhir-server.test-helpers.ts'
import {
  END_TO_END_TIMEOUT_MILLIS,
  endLiftingTest,
  liftingCategoryWire,
  mountLiftingApp,
  seededExerciseRequests,
  seedStartedLifter,
  seedWorkout,
  startLiftingTest,
  SUBJECT,
} from '../lifting-app.test-helpers.ts'

/**
 * Reading the training record and saying what it could not read, driven through
 * `LiftingApp` over the in-memory FHIR server (see
 * `lifting-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startLiftingTest()
})

afterEach(endLiftingTest)

describe('readTrainingRecord', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should read the sets with one search per active request, however many workouts there are', async () => {
    // Arrange — three workouts on the record
    seedStartedLifter(server)
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })
    seedWorkout(server, { squat: [5, 5, 5, 5, 5] })

    // Act
    mountLiftingApp(server)
    await screen.findByRole('heading', { name: 'Workout B' })

    // Assert — the five lifts' requests, and no workout's
    const observationSearches = server.searches
      .filter((query) => resourceTypeOfQuery(query) === 'Observation')
      .map(searchParamsOf)
      .filter((params) => params.has('based-on') || params.has('part-of'))
    expect(observationSearches.every((params) => !params.has('part-of'))).toBe(true)
    expect(new Set(observationSearches.map((params) => params.get('based-on'))).size).toBe(5)
  })

  it('should show a failed read as such, not as an empty record', async () => {
    // Arrange
    server.failSearches()

    // Act
    mountLiftingApp(server)

    // Assert
    expect(await screen.findByText(/^Could not load your training: /)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Start program' })).toBeNull()
  })
})

describe('TrainingRecordNotices', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should count what it could not read, leaving a retracted set out without counting it', async () => {
    // Arrange — a lifting request that is no exercise request, a malformed set
    // and a retracted one
    seedStartedLifter(server)
    server.seedWire({
      resourceType: 'ServiceRequest',
      id: 'sr-not-an-exercise',
      status: 'active',
      intent: 'plan',
      category: [liftingCategoryWire],
      subject: SUBJECT,
    })
    server.seedWire({
      resourceType: 'Observation',
      id: 'set-malformed',
      status: 'final',
      code: { text: 'Squat' },
      subject: SUBJECT,
      basedOn: [{ reference: 'ServiceRequest/sr-squat' }],
    })
    server.seedWire({
      resourceType: 'Observation',
      id: 'set-retracted',
      status: 'entered-in-error',
      code: { text: 'Squat' },
      subject: SUBJECT,
      basedOn: [{ reference: 'ServiceRequest/sr-squat' }],
    })

    // Act
    mountLiftingApp(server)

    // Assert
    expect(
      await screen.findByText(
        '1 exercise request and 1 set on your record could not be read and are left out.'
      )
    ).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Workout A' })).toBeDefined()
  })

  it('should offer a new start when the program the requests follow is not on the server', async () => {
    // Arrange — the requests, but not the PlanDefinition they instantiate
    for (const exerciseRequest of seededExerciseRequests()) server.seedResource(exerciseRequest)

    // Act
    mountLiftingApp(server)

    // Assert
    expect(
      await screen.findByText(
        /Your exercise requests follow a program \(.+\) that could not be found/
      )
    ).toBeDefined()
    expect(screen.getByRole('button', { name: 'Start program' })).toBeDefined()
  })
})
