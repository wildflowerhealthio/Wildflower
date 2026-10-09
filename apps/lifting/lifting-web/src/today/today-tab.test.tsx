import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DateTime, Option } from 'effect'
import { ExerciseSetObservation, WorkoutProcedure } from 'lifting-core-js'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { type FakeFhirServer, idsOf } from '../fake-fhir-server.test-helpers.ts'
import {
  decodedOfType,
  END_TO_END_TIMEOUT_MILLIS,
  endLiftingTest,
  exerciseRequestWireSchema,
  exerciseSetObservationWireSchema,
  loadsByExerciseId,
  mountLiftingApp,
  seedStartedLifter,
  startLiftingTest,
  SUBMITTED_AT,
  tapEverySet,
  workoutProcedureWireSchema,
} from '../lifting-app.test-helpers.ts'

/**
 * The Today tab: a submitted workout written and read back as the next one,
 * driven through `LiftingApp` over the in-memory FHIR server (see `lifting-
 * app.test-helpers.ts`).
 */

let server: FakeFhirServer

beforeEach(() => {
  server = startLiftingTest()
})

afterEach(endLiftingTest)

describe('TodayTab', { timeout: END_TO_END_TIMEOUT_MILLIS }, () => {
  it('should write a submitted workout as one batch — the workout, each set and each moved request — and show its outcome', async () => {
    // Arrange
    const user = userEvent.setup()
    seedStartedLifter(server)
    mountLiftingApp(server)
    await screen.findByRole('heading', { name: 'Workout A' })

    // Act — every set of squat and bench press, none of barbell row
    await tapEverySet(user, 'Squat', 5)
    await tapEverySet(user, 'Bench Press', 5)
    await user.click(screen.getByRole('button', { name: 'Submit workout' }))

    // Assert — the outcome, then the next day once the lifter moves on
    expect(await screen.findByRole('heading', { name: 'Workout A done' })).toBeDefined()
    expect(server.writes).toHaveLength(1)
    const batch = server.writes[0]
    const [workoutProcedure] = decodedOfType(batch, 'Procedure', workoutProcedureWireSchema)
    expect(workoutProcedure?.status).toBe('completed')
    expect(
      Option.map(Option.fromNullable(workoutProcedure), (completed) =>
        Option.map(WorkoutProcedure.endOf(completed), DateTime.formatIso)
      )
    ).toEqual(Option.some(Option.some(SUBMITTED_AT)))
    const exerciseSetObservations = decodedOfType(
      batch,
      'Observation',
      exerciseSetObservationWireSchema
    )
    expect(exerciseSetObservations).toHaveLength(10)
    // Each exercise's sets tie on start, so their ids alone order them.
    for (const exerciseId of ['squat', 'bench-press']) {
      const setIds = exerciseSetObservations
        .filter((set) => ExerciseSetObservation.serviceRequestIdOf(set) === `sr-${exerciseId}`)
        .map(({ id }) => id)
      expect(setIds).toHaveLength(5)
      expect(setIds.toSorted()).toEqual(setIds)
      for (const id of setIds) expect(id).toMatch(/^[A-Za-z0-9\-.]{1,64}$/)
    }
    // The two met lifts close and move up; the row, with no set, is not written.
    const writtenExerciseRequests = decodedOfType(
      batch,
      'ServiceRequest',
      exerciseRequestWireSchema
    )
    expect(
      writtenExerciseRequests
        .filter(({ status }) => status === 'completed')
        .map(({ id }) => id)
        .toSorted()
    ).toEqual(['sr-bench-press', 'sr-squat'])
    expect(
      loadsByExerciseId(writtenExerciseRequests.filter(({ status }) => status === 'active'))
    ).toStrictEqual({ squat: 50, 'bench-press': 50 })
    expect(writtenExerciseRequests.some(({ id }) => id === 'sr-barbell-row')).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Next workout' }))
    expect(await screen.findByRole('heading', { name: 'Workout B' })).toBeDefined()
    expect(screen.getByText('50 lb · 5×5')).toBeDefined()
  })

  it('should retry a partly rejected workout under the same ids, leaving one workout on the record', async () => {
    // Arrange — the first batch's first set is refused
    const user = userEvent.setup()
    seedStartedLifter(server)
    server.rejectOnce('Observation')
    mountLiftingApp(server)
    await screen.findByRole('heading', { name: 'Workout A' })
    await tapEverySet(user, 'Squat', 5)
    await user.click(screen.getByRole('button', { name: 'Submit workout' }))
    expect(await screen.findAllByText(/1 of 8 batch entries were rejected/)).not.toHaveLength(0)

    // Act — the same planned workout is still shown; submit it again
    expect(screen.getByRole('heading', { name: 'Workout A' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Submit workout' }))

    // Assert
    expect(await screen.findByRole('heading', { name: 'Workout A done' })).toBeDefined()
    expect(server.writes).toHaveLength(2)
    expect(server.writes.map(idsOf)).toEqual([idsOf(server.writes[0]), idsOf(server.writes[0])])
    expect(server.storedIds('Procedure')).toHaveLength(1)
    expect(server.storedIds('Observation')).toHaveLength(5)
  })
})
