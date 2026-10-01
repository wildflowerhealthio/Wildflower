import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExerciseRequest, StrongLifts5x5 } from 'lifting-core'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import type { FakeFhirServer } from '../fake-fhir-server.test-helpers.ts'
import {
  decodedOfType,
  END_TO_END_TIMEOUT_MILLIS,
  endLiftingTest,
  exerciseRequestWireSchema,
  loadsByExerciseId,
  loadsOf,
  mountLiftingApp,
  SEEDED_PLAN_DEFINITION_ID,
  seededExerciseRequests,
  seedStartedLifter,
  startLiftingTest,
  trainingPlanDefinitionWireSchema,
} from '../lifting-app.test-helpers.ts'

/**
 * The Plan tab: an edited program saved and started, driven through
 * `LiftingApp` over the in-memory FHIR server (see
 * `lifting-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startLiftingTest()
})

afterEach(endLiftingTest)

describe('PlanTab', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should save an edited program as a new PlanDefinition, then restart on it in one batch at the current loads', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    mountLiftingApp(server)
    await screen.findByRole('heading', { name: 'Workout A' })
    await user.click(screen.getByRole('button', { name: 'Plan' }))

    // Act — retitle the program and save it, then start it
    const title = await screen.findByLabelText('Title')
    await user.clear(title)
    await user.type(title, 'My 5×5')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await user.click(await screen.findByRole('button', { name: 'Start program' }))

    // Assert — the saved definition is new; the old one is left as it was
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(server.writes).toHaveLength(2)
    const [savedTrainingPlanDefinition] = decodedOfType(
      server.writes[0],
      'PlanDefinition',
      trainingPlanDefinitionWireSchema
    )
    expect(server.writes[0]).toHaveLength(1)
    expect(savedTrainingPlanDefinition?.title).toBe('My 5×5')
    expect(savedTrainingPlanDefinition?.id).not.toBe(SEEDED_PLAN_DEFINITION_ID)
    expect(server.storedIds('PlanDefinition')).toHaveLength(2)
    // One batch revokes every active request and starts one per exercise.
    const changedExerciseRequests = decodedOfType(
      server.writes[1],
      'ServiceRequest',
      exerciseRequestWireSchema
    )
    expect(
      changedExerciseRequests
        .filter(({ status }) => status === 'revoked')
        .map(({ id }) => id)
        .toSorted()
    ).toEqual(
      seededExerciseRequests()
        .map(({ id }) => id)
        .toSorted()
    )
    const startedExerciseRequests = changedExerciseRequests.filter(
      ({ status }) => status === 'active'
    )
    expect(loadsByExerciseId(startedExerciseRequests)).toStrictEqual(
      loadsOf(StrongLifts5x5.STARTING_LOADS)
    )
    for (const exerciseRequest of startedExerciseRequests) {
      expect(ExerciseRequest.trainingPlanDefinitionUrlOf(exerciseRequest)).toBe(
        savedTrainingPlanDefinition?.url
      )
    }
  })
})
