import { act, renderHook } from '@testing-library/react'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { useFormState } from './use-form-state.ts'

describe('useFormState', () => {
  it('should set one field and leave the others as they are', () => {
    const { result } = renderHook(() => useFormState(blankPlan))

    act(() => {
      result.current.set('title', 'Strength')
    })

    expect(result.current.value).toStrictEqual({ ...blankPlan, title: 'Strength' })
  })

  it('should land every setter called in one event', () => {
    // Arrange
    const { result } = renderHook(() => useFormState(blankPlan))

    // Act: three setters before React renders again.
    act(() => {
      result.current.set('title', 'Strength')
      result.current.list('days').add(dayB)
      result.current.field('notesByDay').set('B', 'Deadlift day')
    })

    // Assert
    expect(result.current.value).toStrictEqual({
      title: 'Strength',
      days: [dayA, dayB],
      notesByDay: { B: 'Deadlift day' },
    })
  })

  it('should replace the whole state, or change it by an edit of it as it stands', () => {
    const { result } = renderHook(() => useFormState(blankPlan))

    act(() => {
      result.current.replace({ ...blankPlan, title: 'Five by five' })
      result.current.update((current) => ({ ...current, title: `${current.title}!` }))
    })

    expect(result.current.value.title).toBe('Five by five!')
  })

  it('should start from the state a function makes', () => {
    const { result } = renderHook(() => useFormState(() => ({ ...blankPlan, title: 'Made' })))

    expect(result.current.value.title).toBe('Made')
  })

  it('should edit an item of a list in place through its own state, nested lists too', () => {
    // Arrange
    const { result } = renderHook(() => useFormState({ ...blankPlan, days: [dayA, dayB] }))

    // Act: what a day's sub-form does with the state it is handed.
    act(() => {
      result.current.list('days').map((day, index) => {
        if (index !== 1) return
        day.set('label', 'C')
        day.list('exercises').add('Overhead Press')
      })
    })

    // Assert
    expect(result.current.value.days).toStrictEqual([
      dayA,
      { label: 'C', exercises: ['Squat', 'Deadlift', 'Overhead Press'] },
    ])
  })

  it('should update and remove an item by index, and leave the list be at an index it lacks', () => {
    const { result } = renderHook(() => useFormState({ ...blankPlan, days: [dayA, dayB] }))

    act(() => {
      const days = result.current.list('days')
      days.update(0, (day) => ({ ...day, label: 'Z' }))
      days.update(5, (day) => ({ ...day, label: 'Y' }))
      days.remove(1)
      days.remove(5)
    })

    expect(result.current.value.days).toStrictEqual([{ ...dayA, label: 'Z' }])
  })

  it("should swap an item with its neighbour, and leave a list's ends where they are", () => {
    const { result } = renderHook(() =>
      useFormState({ ...blankPlan, days: [{ label: 'A', exercises: ['Squat', 'Bench', 'Row'] }] })
    )
    const exercisesOfDayA = (): readonly string[] => result.current.value.days[0]?.exercises ?? []

    act(() => {
      result.current.list('days').map((day) => {
        day.list('exercises').move(2, -1)
      })
    })
    const swapped = exercisesOfDayA()
    act(() => {
      result.current.list('days').map((day) => {
        day.list('exercises').move(0, -1)
        day.list('exercises').move(2, 1)
      })
    })

    expect(swapped).toEqual(['Squat', 'Row', 'Bench'])
    expect(exercisesOfDayA()).toBe(swapped)
  })

  it('should move an item and back to where it started', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 2 }).chain((items) =>
          fc.record({
            items: fc.constant(items),
            index: fc.nat({ max: items.length - 2 }),
          })
        ),
        ({ items, index }) => {
          const { result, unmount } = renderHook(() => useFormState({ items }))

          act(() => {
            result.current.list('items').move(index, 1)
          })
          const moved = result.current.value.items
          act(() => {
            result.current.list('items').move(index + 1, -1)
          })

          expect(moved[index + 1]).toBe(items[index])
          expect(result.current.value.items).toStrictEqual(items)
          unmount()
        }
      )
    )
  })

  it('should refuse, at the type level, a list setter on a field that holds no list and a value of the wrong type', () => {
    // The refusals are the type checker's: each `@ts-expect-error` fails the
    // check once its line type-checks. The setters are built, never called.
    const { result } = renderHook(() => useFormState(blankPlan))

    const refused = [
      // @ts-expect-error -- `title` holds a string, not a list
      () => result.current.list('title'),
      // @ts-expect-error -- a day is not a string
      () => result.current.list('days').add('A'),
      // @ts-expect-error -- the title is a string
      () => result.current.set('title', 1),
    ]

    expect(refused).toHaveLength(3)
    expect(result.current.value).toBe(blankPlan)
  })
})

// Helpers

interface Day {
  readonly label: string
  readonly exercises: readonly string[]
}

interface Plan {
  readonly title: string
  readonly days: readonly Day[]
  readonly notesByDay: Readonly<Record<string, string>>
}

const dayA: Day = { label: 'A', exercises: ['Squat', 'Bench'] }

const dayB: Day = { label: 'B', exercises: ['Squat', 'Deadlift'] }

const blankPlan: Plan = { title: '', days: [dayA], notesByDay: {} }
