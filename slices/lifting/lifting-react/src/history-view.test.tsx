import { cleanup, render, screen, within } from '@testing-library/react'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { type ExerciseAttempt, type ExerciseGoal, strongLifts5x5 } from 'lifting-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { HistoryView } from './history-view.tsx'

beforeEach(() => {
  // Pin a UTC-negative zone and the clock so nothing depends on the machine
  // running the suite: America/Los_Angeles is UTC-7 in September, so an
  // evening session there has already reached the next UTC day.
  vi.stubEnv('TZ', 'America/Los_Angeles')
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('HistoryView', () => {
  it('should say so when nothing is logged', () => {
    render(<HistoryView plan={stronglifts} attempts={[]} />)

    expect(screen.getByText(/No sessions logged yet/)).toBeDefined()
  })

  it('should group attempts by local calendar day, newest day first', () => {
    // 00:30Z on the 23rd is 17:30 on Tuesday the 22nd in Los Angeles; 23:30Z
    // on the 23rd is 16:30 on Wednesday the 23rd. By UTC day they would share
    // a group.
    const attempts = [
      attemptOf(goal('squat'), 'A', '2026-09-21T17:30:00Z', [5, 5, 5, 5, 5]),
      attemptOf(goal('squat'), 'B', '2026-09-23T00:30:00Z', [5, 5, 5, 5, 5]),
      attemptOf(goal('deadlift'), 'B', '2026-09-23T23:30:00Z', [5]),
    ]

    render(<HistoryView plan={stronglifts} attempts={attempts} />)

    expect(dayHeadings()).toEqual(['Wed, Sep 23, 2026', 'Tue, Sep 22, 2026', 'Mon, Sep 21, 2026'])
    expect(rowTitlesUnder('Wed, Sep 23, 2026')).toEqual(['Deadlift'])
    expect(rowTitlesUnder('Tue, Sep 22, 2026')).toEqual(['Squat'])
    expect(rowTitlesUnder('Mon, Sep 21, 2026')).toEqual(['Squat'])
  })

  it('should show the workout, load and reps per set, badged by attemptSucceeded', () => {
    const attempts = [
      attemptOf(goal('squat'), 'A', '2026-09-21T17:30:00Z', [5, 5, 5, 4, 3]),
      attemptOf(goal('bench-press'), 'A', '2026-09-21T17:40:00Z', [5, 5, 5, 5, 5]),
    ]

    render(<HistoryView plan={stronglifts} attempts={attempts} />)

    const squatRow = rowOf('Squat')
    expect(squatRow.textContent).toContain('Workout A · 45 lb · 5/5/5/4/3')
    expect(within(squatRow).getByRole('status').textContent).toContain('Failed')
    expect(within(rowOf('Bench Press')).getByRole('status').textContent).toContain('Success')
  })

  it('should name an attempt by the plan, or by its own record once the plan drops the lift', () => {
    const renamed: ExerciseGoal = {
      ...goal('squat'),
      exercise: { id: 'squat', name: 'Squat (old)' },
    }
    const retired: ExerciseGoal = {
      ...goal('squat'),
      exercise: { id: 'front-squat', name: 'Front Squat' },
    }

    render(
      <HistoryView
        plan={stronglifts}
        attempts={[
          attemptOf(renamed, 'A', '2026-09-21T17:30:00Z', [5, 5, 5, 5, 5]),
          attemptOf(retired, 'A', '2026-09-21T17:40:00Z', [5, 5, 5, 5, 5]),
        ]}
      />
    )

    expect(rowOf('Squat')).toBeDefined()
    expect(rowOf('Front Squat')).toBeDefined()
  })

  it('should list every attempt once, under as many local days as they span', () => {
    const instantArb = fc
      .integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 11, 31) })
      .map((epochMillis) => DateTime.unsafeMake(epochMillis))
    fc.assert(
      fc.property(fc.array(instantArb, { maxLength: 12 }), (instants) => {
        const attempts = instants.map((performedAt) =>
          attemptOf(goal('deadlift'), 'B', DateTime.formatIso(performedAt), [5])
        )
        render(<HistoryView plan={stronglifts} attempts={attempts} />)
        try {
          // `en-CA` writes a date as YYYY-MM-DD, in the (stubbed) local zone.
          const days = new Set(
            instants.map((instant) => DateTime.toDateUtc(instant).toLocaleDateString('en-CA'))
          )
          expect(screen.queryAllByRole('listitem').length).toBe(attempts.length)
          expect(screen.queryAllByRole('heading', { level: 3 }).length).toBe(days.size)
        } finally {
          cleanup()
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

// Helpers

const stronglifts = strongLifts5x5()

/** The StrongLifts goal for one lift. */
const goal = (exerciseId: string): ExerciseGoal => {
  const found = stronglifts.goalsByExerciseId[exerciseId]
  if (found === undefined) throw new Error(`no StrongLifts goal ${exerciseId}`)
  return found
}

/** An attempt at the goal's prescription, performed at an ISO instant, with the given reps. */
const attemptOf = (
  exerciseGoal: ExerciseGoal,
  workoutLabel: string,
  performedAtIso: string,
  repsCompleted: readonly number[]
): ExerciseAttempt => ({
  exercise: exerciseGoal.exercise,
  workoutLabel,
  performedAt: DateTime.unsafeMake(performedAtIso),
  loadLb: exerciseGoal.loadLb,
  prescribedSets: exerciseGoal.sets,
  prescribedReps: exerciseGoal.reps,
  repsCompleted,
})

/** The day headings, in order. */
const dayHeadings = (): readonly (string | null)[] =>
  screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)

/** The exercise names listed under one day heading, in order. */
const rowTitlesUnder = (dayHeading: string): readonly (string | null)[] => {
  const day = screen.getByRole('heading', { level: 3, name: dayHeading }).closest('section')
  if (day === null) throw new Error(`no day ${dayHeading}`)
  return Array.from(day.querySelectorAll('li span.text-body-2'), (title) => title.textContent)
}

/** The row of the named exercise; there must be exactly one. */
const rowOf = (exerciseName: string): HTMLElement => {
  const row = screen.getByText(exerciseName, { selector: 'span.text-body-2' }).closest('li')
  if (row === null) throw new Error(`no row for ${exerciseName}`)
  return row
}
