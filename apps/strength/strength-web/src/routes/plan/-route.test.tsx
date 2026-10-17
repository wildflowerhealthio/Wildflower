import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExerciseRequest, StrongLifts5x5 } from '@wildflowerhealthio/strength-core-js'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import type { FakeFhirServer } from '../../fake-fhir-server.test-helpers.ts'
import {
  currentRoute,
  decodedOfType,
  END_TO_END_TIMEOUT_MILLIS,
  endStrengthTest,
  exerciseRequestWireSchema,
  loadsByExerciseId,
  loadsOf,
  mountStrengthApp,
  SEEDED_PLAN_DEFINITION_ID,
  seededExerciseRequests,
  seedStartedLifter,
  startStrengthTest,
  tabLink,
  trainingPlanDefinitionWireSchema,
} from '../../strength-app.test-helpers.ts'

/**
 * The Plan tab: an edited program saved and started, driven through
 * the app's router over the in-memory FHIR server (see
 * `strength-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startStrengthTest()
})

afterEach(endStrengthTest)

describe('PlanTab', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should open Plan at /plan', async () => {
    // Arrange
    seedStartedLifter(server)

    // Act
    mountStrengthApp(server, { route: 'plan' })

    // Assert
    expect(await screen.findByLabelText('Title')).toBeDefined()
    expect(tabLink('Plan').getAttribute('aria-current')).toBe('page')
    expect(currentRoute()).toBe('plan')
    expect(screen.queryByRole('heading', { name: 'Workout A' })).toBeNull()
  })

  it('should save an edited program as a new PlanDefinition, then restart on it in one batch at the current loads', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    mountStrengthApp(server)
    await screen.findByRole('heading', { name: 'Workout A' })
    await user.click(tabLink('Plan'))

    // Act — retitle the program and save it, then start it
    const title = await screen.findByLabelText('Title')
    await user.clear(title)
    await user.type(title, 'My 5×5')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await user.click(await screen.findByRole('button', { name: 'Start program' }))

    // Assert — Today opens on the started program; the saved definition is
    // new, and the old one is left as it was
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(currentRoute()).toBe('today')
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
