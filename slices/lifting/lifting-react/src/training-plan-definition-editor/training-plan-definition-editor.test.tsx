import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExerciseConcept, StrongLifts5x5, TrainingPlanDefinition } from 'lifting-core'
import { someOrFail } from 'lifting-core/test-helpers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { TrainingPlanDefinitionEditor } from './training-plan-definition-editor.tsx'

afterEach(() => {
  cleanup()
})

describe('TrainingPlanDefinitionEditor', () => {
  it('should save the StrongLifts seed exactly as the template makes it', async () => {
    // Arrange
    const user = userEvent.setup()
    const onSave = vi.fn<(trainingPlanDefinition: TrainingPlanDefinition.Type) => void>()
    render(
      <TrainingPlanDefinitionEditor initial={null} planDefinitionId="plan-1" onSave={onSave} />
    )

    // Act
    await user.click(screen.getByRole('button', { name: 'Start from StrongLifts 5×5' }))
    await user.click(saveButton())

    // Assert
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0]?.[0]).toStrictEqual(strongLifts)
  })

  it('should offer the StrongLifts seed only for a new training plan definition', () => {
    render(
      <TrainingPlanDefinitionEditor
        initial={strongLifts}
        planDefinitionId="plan-1"
        onSave={() => undefined}
      />
    )

    expect(screen.queryByRole('button', { name: 'Start from StrongLifts 5×5' })).toBeNull()
  })

  it('should refuse an empty form and show each problem under its field', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn<(trainingPlanDefinition: TrainingPlanDefinition.Type) => void>()
    render(
      <TrainingPlanDefinitionEditor initial={null} planDefinitionId="plan-1" onSave={onSave} />
    )

    await user.click(saveButton())

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(
      '2 problems to fix — see the highlighted fields.'
    )
    expect(screen.getByText('Add at least one exercise to this day')).toBeDefined()
  })

  it('should hold back a rule out of range, under its field, until it is corrected', async () => {
    // Arrange
    const user = userEvent.setup()
    const onSave = vi.fn<(trainingPlanDefinition: TrainingPlanDefinition.Type) => void>()
    render(
      <TrainingPlanDefinitionEditor
        initial={strongLifts}
        planDefinitionId="plan-1"
        onSave={onSave}
      />
    )
    const benchDeload = within(exerciseGroup('Day 1', 2)).getByLabelText('Deload fraction')

    // Act: save a fraction of 1, then correct it and save again.
    await user.clear(benchDeload)
    await user.type(benchDeload, '1')
    await user.click(saveButton())
    const problemShown = within(exerciseGroup('Day 1', 2)).queryByText(
      'Expected a number less than 1, actual 1'
    )
    await user.clear(benchDeload)
    await user.type(benchDeload, '0.2')
    await user.click(saveButton())

    // Assert
    expect(problemShown).not.toBeNull()
    expect(onSave).toHaveBeenCalledOnce()
    const benchPress = someOrFail(
      TrainingPlanDefinition.exerciseOf({
        trainingPlanDefinition: savedBy(onSave),
        exerciseId: 'bench-press',
      })
    )
    expect(
      TrainingPlanDefinition.ProgressionRule.deloadFractionOf(
        TrainingPlanDefinition.Exercise.progressionRuleOf(benchPress)
      )
    ).toBe(0.2)
  })

  it('should make a new exercise in kilograms, its id slugged from its name', async () => {
    // Arrange
    const user = userEvent.setup()
    const onSave = vi.fn<(trainingPlanDefinition: TrainingPlanDefinition.Type) => void>()
    render(
      <TrainingPlanDefinitionEditor initial={null} planDefinitionId="plan-2" onSave={onSave} />
    )

    // Act
    await user.type(screen.getByLabelText('Title'), 'Press day')
    await user.click(screen.getByRole('button', { name: 'Add exercise to day A' }))
    const row = exerciseGroup('Day 1', 1)
    await user.type(within(row).getByLabelText('Name'), 'Incline Bench Press')
    await user.selectOptions(within(row).getByLabelText('Unit'), 'kg')
    await user.clear(within(row).getByLabelText('Minimum load (kg)'))
    await user.type(within(row).getByLabelText('Minimum load (kg)'), '20')
    await user.click(saveButton())

    // Assert
    const saved = savedBy(onSave)
    expect(saved.title).toBe('Press day')
    expect(TrainingPlanDefinition.exercisesOf(saved).map(describeExercise)).toEqual([
      {
        exerciseId: 'incline-bench-press',
        name: 'Incline Bench Press',
        setsByReps: '5×5',
        unit: 'kg',
        minimumLoad: 20,
      },
    ])
  })

  it('should put an exercise defined two ways under the later row', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn<(trainingPlanDefinition: TrainingPlanDefinition.Type) => void>()
    render(
      <TrainingPlanDefinitionEditor
        initial={strongLifts}
        planDefinitionId="plan-1"
        onSave={onSave}
      />
    )
    const daySquatSets = within(exerciseGroup('Day 2', 1)).getByLabelText('Sets')

    await user.clear(daySquatSets)
    await user.type(daySquatSets, '3')
    await user.click(saveButton())

    expect(onSave).not.toHaveBeenCalled()
    expect(exerciseGroup('Day 2', 1).textContent).toContain(
      'expected "squat" defined as on the first day that runs it'
    )
  })

  it("should reorder a day's exercises and remove one", async () => {
    // Arrange
    const user = userEvent.setup()
    const onSave = vi.fn<(trainingPlanDefinition: TrainingPlanDefinition.Type) => void>()
    render(
      <TrainingPlanDefinitionEditor
        initial={strongLifts}
        planDefinitionId="plan-1"
        onSave={onSave}
      />
    )

    // Act
    await user.click(screen.getByRole('button', { name: 'Move Deadlift in day B earlier' }))
    await user.click(screen.getByRole('button', { name: 'Remove Bench Press in day A' }))
    await user.click(saveButton())

    // Assert
    expect(
      TrainingPlanDefinition.daysOf(savedBy(onSave)).map((day) =>
        TrainingPlanDefinition.Day.exercisesOf(day).map(
          TrainingPlanDefinition.Exercise.exerciseIdOf
        )
      )
    ).toEqual([
      ['squat', 'barbell-row'],
      ['squat', 'deadlift', 'overhead-press'],
    ])
  })

  it('should disable every field and action while the training plan definition is saving', () => {
    render(
      <TrainingPlanDefinitionEditor
        initial={strongLifts}
        planDefinitionId="plan-1"
        onSave={() => undefined}
        pending
      />
    )

    const controls = [
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('combobox'),
      ...screen.getAllByRole('button'),
    ]
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) expect(control.matches(':disabled')).toBe(true)
  })

  it('should show a failed save in an alert and offer cancel when given one', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn<() => void>()
    render(
      <TrainingPlanDefinitionEditor
        initial={strongLifts}
        planDefinitionId="plan-1"
        onSave={() => undefined}
        onCancel={onCancel}
        error="The server is unreachable"
      />
    )

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('alert').textContent).toContain('The server is unreachable')
    expect(onCancel).toHaveBeenCalledOnce()
  })
})

// Helpers

const strongLifts = StrongLifts5x5.trainingPlanDefinition('plan-1')

/** The save action. */
const saveButton = (): HTMLElement => screen.getByRole('button', { name: 'Save' })

/** The training plan definition the editor saved first. */
const savedBy = (onSave: {
  readonly mock: { readonly calls: readonly (readonly [TrainingPlanDefinition.Type])[] }
}): TrainingPlanDefinition.Type => {
  const saved = onSave.mock.calls[0]?.[0]
  if (saved === undefined) throw new Error('nothing saved')
  return saved
}

/** The fieldset of the Nth (1-based) exercise row of a day's fieldset. */
const exerciseGroup = (dayLegend: string, position: number): HTMLElement =>
  within(screen.getByRole('group', { name: dayLegend })).getByRole('group', {
    name: `Exercise ${position}`,
  })

/** What an exercise (definition) holds, as its getters read it. */
const describeExercise = (
  exercise: TrainingPlanDefinition.Exercise.Type
): Readonly<Record<string, unknown>> => {
  const progressionRule = TrainingPlanDefinition.Exercise.progressionRuleOf(exercise)
  return {
    exerciseId: TrainingPlanDefinition.Exercise.exerciseIdOf(exercise),
    name: ExerciseConcept.nameOf(TrainingPlanDefinition.Exercise.exerciseConceptOf(exercise)),
    setsByReps: `${TrainingPlanDefinition.Exercise.setsOf(exercise)}×${TrainingPlanDefinition.Exercise.repsOf(exercise)}`,
    unit: TrainingPlanDefinition.ProgressionRule.unitOf(progressionRule),
    minimumLoad: TrainingPlanDefinition.ProgressionRule.minimumLoadOf(progressionRule),
  }
}
