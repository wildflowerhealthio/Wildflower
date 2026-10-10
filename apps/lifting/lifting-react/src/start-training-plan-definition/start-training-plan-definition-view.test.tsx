import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import {
  ExerciseConcept,
  ExerciseRequest,
  Load,
  StrongLifts5x5,
  TrainingPlanDefinition,
} from '@wildflowerhealthio/lifting-core-js'
import {
  AUTHORED_ON,
  made,
  someOrFail,
  SUBJECT,
  trainingPlanDefinitionArb,
} from '@wildflowerhealthio/lifting-core-js/test-helpers'
import { Either } from 'effect'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import {
  StartTrainingPlanDefinitionView,
  type StartTrainingPlanDefinitionViewProps,
  type TrainingPlanDefinitionStart,
} from './start-training-plan-definition-view.tsx'

afterEach(() => {
  cleanup()
})

describe('StartTrainingPlanDefinitionView', () => {
  it('should start StrongLifts at the suggested loads as they stand', async () => {
    // Arrange
    const user = userEvent.setup()
    const onStart = vi.fn<(start: TrainingPlanDefinitionStart) => void>()
    render(<StartTrainingPlanDefinitionView {...startProps({ onStart })} />)

    // Act
    await user.click(startButton())

    // Assert
    expect(onStart).toHaveBeenCalledOnce()
    expect(onStart.mock.calls[0]?.[0]).toStrictEqual({
      trainingPlanDefinition: strongLifts,
      startingLoads: StrongLifts5x5.STARTING_LOADS,
    })
  })

  it('should refuse a load under the minimum or that is no number, under its field', async () => {
    // Arrange
    const user = userEvent.setup()
    const onStart = vi.fn<(start: TrainingPlanDefinitionStart) => void>()
    render(<StartTrainingPlanDefinitionView {...startProps({ onStart })} />)

    // Act
    await user.clear(screen.getByLabelText('Squat (lb)'))
    await user.type(screen.getByLabelText('Squat (lb)'), '40')
    await user.clear(screen.getByLabelText('Deadlift (lb)'))
    await user.click(startButton())

    // Assert
    expect(onStart).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(
      '2 starting loads to fix — see the highlighted fields.'
    )
    expect(screen.getByText('expected a load of at least 45 [lb_av]')).toBeDefined()
    expect(screen.getByText('Enter a number')).toBeDefined()
  })

  it('should start the training plan definition chosen, keeping a load entered for an exercise both share', async () => {
    // Arrange: a one-day squat program beside StrongLifts.
    const user = userEvent.setup()
    const onStart = vi.fn<(start: TrainingPlanDefinitionStart) => void>()
    render(
      <StartTrainingPlanDefinitionView
        {...startProps({ onStart, trainingPlanDefinitions: [strongLifts, squatOnly] })}
      />
    )

    // Act
    await user.clear(screen.getByLabelText('Squat (lb)'))
    await user.type(screen.getByLabelText('Squat (lb)'), '135')
    await user.click(screen.getByRole('radio', { name: 'Squat only' }))
    await user.click(startButton())

    // Assert
    expect(onStart.mock.calls[0]?.[0]).toStrictEqual({
      trainingPlanDefinition: squatOnly,
      startingLoads: { squat: pounds(135) },
    })
  })

  it('should not offer a suggested load in another unit than the rule moves', () => {
    render(
      <StartTrainingPlanDefinitionView
        {...startProps({
          suggestedStartingLoads: {
            ...StrongLifts5x5.STARTING_LOADS,
            squat: made(Load.make({ value: 60, unit: 'kg' })),
          },
        })}
      />
    )

    expect(screen.getByLabelText('Squat (lb)')).toHaveProperty('value', '')
    expect(screen.getByLabelText('Deadlift (lb)')).toHaveProperty('value', '95')
  })

  it('should disable every field and the start action while the start is written, and show a failed write', () => {
    render(
      <StartTrainingPlanDefinitionView
        {...startProps({ pending: true, error: 'The server is unreachable' })}
      />
    )

    for (const control of [
      ...screen.getAllByRole('textbox'),
      screen.getByRole('button', { name: 'Starting…' }),
    ])
      expect(control.matches(':disabled')).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('The server is unreachable')
  })

  it("should start any training plan definition at its rules' minimum loads as makeForEachExercise accepts", async () => {
    await fc.assert(
      fc.asyncProperty(trainingPlanDefinitionArb, async (trainingPlanDefinition) => {
        // Arrange: no timer between keystrokes, as a plan of many exercises is many loads typed.
        const user = userEvent.setup({ delay: null })
        const onStart = vi.fn<(start: TrainingPlanDefinitionStart) => void>()
        render(
          <StartTrainingPlanDefinitionView
            {...startProps({
              trainingPlanDefinitions: [trainingPlanDefinition],
              suggestedStartingLoads: {},
              onStart,
            })}
          />
        )
        try {
          // Act: type each rule's minimum load into its field, in order.
          const fields = screen.getAllByRole('textbox')
          const exercises = TrainingPlanDefinition.exercisesOf(trainingPlanDefinition)
          for (const [index, exercise] of exercises.entries()) {
            const field = fields[index]
            if (field === undefined) throw new Error(`no field for ${index}`)
            // oxlint-disable-next-line no-await-in-loop -- a person fills one field after another
            await user.type(
              field,
              String(
                TrainingPlanDefinition.ProgressionRule.minimumLoadOf(
                  TrainingPlanDefinition.Exercise.progressionRuleOf(exercise)
                )
              )
            )
          }
          await user.click(startButton())

          // Assert
          expect(fields.length).toBe(exercises.length)
          const start = onStart.mock.calls[0]?.[0]
          if (start === undefined) throw new Error('not started')
          expect(
            Either.isRight(
              ExerciseRequest.makeForEachExercise({
                ...start,
                subject: SUBJECT,
                mintServiceRequestId: (exerciseId) => `sr-${exerciseId}`,
                authoredOn: AUTHORED_ON,
              })
            )
          ).toBe(true)
        } finally {
          cleanup()
        }
      }),
      { numRuns: numRunsFor({ base: 15 }) }
    )
  })
})

// Helpers

const strongLifts = StrongLifts5x5.trainingPlanDefinition('plan-1')

/** A one-day program of StrongLifts' squat, as StrongLifts defines it. */
const squatOnly = made(
  TrainingPlanDefinition.make({
    planDefinitionId: 'plan-2',
    title: 'Squat only',
    trainingPlanDefinitionDays: [
      made(
        TrainingPlanDefinition.Day.make({
          label: 'A',
          trainingPlanDefinitionExercises: [
            someOrFail(
              TrainingPlanDefinition.exerciseOf({
                trainingPlanDefinition: strongLifts,
                exerciseId: ExerciseConcept.idOf(StrongLifts5x5.EXERCISES.squat),
              })
            ),
          ],
        })
      ),
    ],
  })
)

/** A load in pounds. */
const pounds = (value: number): Load.Type => made(Load.make({ value, unit: '[lb_av]' }))

/** StartTrainingPlanDefinitionView props offering StrongLifts at its own loads, with overrides. */
const startProps = (
  overrides: Partial<StartTrainingPlanDefinitionViewProps> = {}
): StartTrainingPlanDefinitionViewProps => ({
  trainingPlanDefinitions: [strongLifts],
  suggestedStartingLoads: StrongLifts5x5.STARTING_LOADS,
  onStart: () => undefined,
  ...overrides,
})

/** The start action. */
const startButton = (): HTMLElement => screen.getByRole('button', { name: 'Start program' })
