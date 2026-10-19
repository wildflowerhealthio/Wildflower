import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExerciseRequest, StrongLifts5x5 } from '@wildflowerhealthio/strength-core-js'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import type { FakeFhirServer } from '../fake-fhir-server.test-helpers.ts'
import {
  decodedOfType,
  END_TO_END_TIMEOUT_MILLIS,
  endStrengthTest,
  exerciseRequestWireSchema,
  loadsByExerciseId,
  loadsOf,
  mountStrengthApp,
  startStrengthTest,
  trainingPlanDefinitionWireSchema,
} from '../strength-app.test-helpers.ts'

/**
 * Starting a program: the template and its requests written in one batch,
 * driven through the app's router over the in-memory FHIR server (see
 * `strength-app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startStrengthTest()
})

afterEach(endStrengthTest)

describe('StartProgram', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should start StrongLifts 5×5 in one batch that reads back as its first workout', async () => {
    // Arrange — nothing on the server yet
    const user = userEvent.setup()
    mountStrengthApp(server)

    // Act
    await user.click(await screen.findByRole('button', { name: 'Start program' }))

    // Assert — the template and one request per lift, each at its starting load
    expect(await screen.findByRole('heading', { name: 'Workout A' })).toBeDefined()
    expect(server.writes).toHaveLength(1)
    const [trainingPlanDefinition] = decodedOfType(
      server.writes[0],
      'PlanDefinition',
      trainingPlanDefinitionWireSchema
    )
    expect(trainingPlanDefinition?.title).toBe('StrongLifts 5×5')
    const startedExerciseRequests = decodedOfType(
      server.writes[0],
      'ServiceRequest',
      exerciseRequestWireSchema
    )
    expect(loadsByExerciseId(startedExerciseRequests)).toStrictEqual(
      loadsOf(StrongLifts5x5.STARTING_LOADS)
    )
    for (const exerciseRequest of startedExerciseRequests) {
      expect(exerciseRequest.status).toBe('active')
      expect(ExerciseRequest.trainingPlanDefinitionUrlOf(exerciseRequest)).toBe(
        trainingPlanDefinition?.url
      )
    }
  })
})
