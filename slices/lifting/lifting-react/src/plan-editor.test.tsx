import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type Plan, strongLifts5x5 } from 'lifting-core'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { PlanEditor } from './plan-editor.tsx'

afterEach(() => {
  cleanup()
})

describe('PlanEditor', () => {
  it('should save the StrongLifts seed exactly as the template builds it', async () => {
    // Arrange
    const user = userEvent.setup()
    const onSave = vi.fn<(plan: Plan) => void>()
    render(<PlanEditor initial={null} onSave={onSave} />)

    // Act
    await user.click(screen.getByRole('button', { name: 'Start from StrongLifts 5×5' }))
    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    // Assert
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0]?.[0]).toStrictEqual(stronglifts)
  })

  it('should offer the StrongLifts seed only for a new plan', () => {
    render(<PlanEditor initial={stronglifts} onSave={() => undefined} />)

    expect(screen.queryByRole('button', { name: 'Start from StrongLifts 5×5' })).toBeNull()
  })

  it('should refuse an empty form and show each problem under its field', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn<(plan: Plan) => void>()
    render(<PlanEditor initial={null} onSave={onSave} />)

    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe(
      '2 problems to fix — see the highlighted fields.'
    )
    expect(screen.getByText('Give the plan a title')).toBeDefined()
    expect(screen.getByText('Add at least one exercise to this workout')).toBeDefined()
  })

  it('should hold back a load that is not a number until it is corrected', async () => {
    // Arrange
    const user = userEvent.setup()
    const onSave = vi.fn<(plan: Plan) => void>()
    render(<PlanEditor initial={stronglifts} onSave={onSave} />)
    const squatLoad = within(exerciseGroup(1)).getByLabelText('Load (lb)')

    // Act: save a non-number, then correct it and save again.
    await user.clear(squatLoad)
    await user.type(squatLoad, 'heavy')
    await user.click(screen.getByRole('button', { name: 'Save plan' }))
    const problemShown = within(exerciseGroup(1)).queryByText(
      'Enter a load of at least the minimum load'
    )
    await user.clear(squatLoad)
    await user.type(squatLoad, '50')
    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    // Assert
    expect(problemShown).not.toBeNull()
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0]?.[0].goalsByExerciseId['squat']?.loadLb).toBe(50)
  })

  it("should refuse a deload percentage outside lifting-core's range", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn<(plan: Plan) => void>()
    render(<PlanEditor initial={stronglifts} onSave={onSave} />)
    const squatDeload = within(exerciseGroup(1)).getByLabelText('Deload (%)')

    await user.clear(squatDeload)
    await user.type(squatDeload, '100')
    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(
      within(exerciseGroup(1)).getByText('Enter a percentage above 0 and below 100')
    ).toBeDefined()
  })

  it('should build a new plan with an id slugged from the exercise name', async () => {
    // Arrange
    const user = userEvent.setup()
    const onSave = vi.fn<(plan: Plan) => void>()
    render(<PlanEditor initial={null} onSave={onSave} />)

    // Act
    await user.type(screen.getByLabelText('Title'), 'Press day')
    await user.click(screen.getByRole('button', { name: 'Add exercise' }))
    await user.type(within(exerciseGroup(1)).getByLabelText('Name'), 'Incline Bench Press')
    await user.type(within(exerciseGroup(1)).getByLabelText('Load (lb)'), '95')
    await user.selectOptions(screen.getByLabelText('Add to workout A'), 'Incline Bench Press')
    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    // Assert
    const saved = onSave.mock.calls[0]?.[0]
    expect(saved?.title).toBe('Press day')
    expect(saved?.workouts).toEqual([{ label: 'A', exerciseIds: ['incline-bench-press'] }])
    expect(saved?.goalsByExerciseId['incline-bench-press']).toEqual({
      exercise: { id: 'incline-bench-press', name: 'Incline Bench Press' },
      loadLb: 95,
      sets: 5,
      reps: 5,
      progression: {
        incrementLb: 5,
        failuresBeforeDeload: 3,
        deloadFraction: 0.1,
        minimumLoadLb: 0,
        loadStepLb: 5,
      },
    })
  })

  it('should keep an existing exercise id when the exercise is renamed', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn<(plan: Plan) => void>()
    render(<PlanEditor initial={stronglifts} onSave={onSave} />)
    const squatName = within(exerciseGroup(1)).getByLabelText('Name')

    await user.clear(squatName)
    await user.type(squatName, 'Back Squat')
    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    expect(onSave.mock.calls[0]?.[0].goalsByExerciseId['squat']?.exercise).toEqual({
      id: 'squat',
      name: 'Back Squat',
    })
  })

  it("should reorder a workout's exercises and drop a removed exercise from every workout", async () => {
    // Arrange
    const user = userEvent.setup()
    const onSave = vi.fn<(plan: Plan) => void>()
    render(<PlanEditor initial={stronglifts} onSave={onSave} />)

    // Act
    await user.click(screen.getByRole('button', { name: 'Move Deadlift earlier in workout B' }))
    await user.click(within(exerciseGroup(1)).getByRole('button', { name: 'Remove exercise' }))
    await user.click(screen.getByRole('button', { name: 'Save plan' }))

    // Assert
    const saved = onSave.mock.calls[0]?.[0]
    expect(saved?.workouts).toEqual([
      { label: 'A', exerciseIds: ['bench-press', 'barbell-row'] },
      { label: 'B', exerciseIds: ['deadlift', 'overhead-press'] },
    ])
    expect(Object.keys(saved?.goalsByExerciseId ?? {})).not.toContain('squat')
  })

  it('should disable every field and action while the plan is saving', () => {
    render(<PlanEditor initial={stronglifts} onSave={() => undefined} pending />)

    const controls = [...screen.getAllByRole('textbox'), ...screen.getAllByRole('button')]
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) expect(control.matches(':disabled')).toBe(true)
  })

  it('should show a failed save in an alert and offer cancel when given one', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn<() => void>()
    render(
      <PlanEditor
        initial={stronglifts}
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

const stronglifts = strongLifts5x5()

/** The fieldset of the Nth exercise row (1-based). */
const exerciseGroup = (position: number): HTMLElement =>
  screen.getByRole('group', { name: `Exercise ${position}` })
