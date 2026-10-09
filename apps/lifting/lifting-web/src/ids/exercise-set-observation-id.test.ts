import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { exerciseSetObservationIdOf, FHIR_ID_MAX_LENGTH } from './exercise-set-observation-id.ts'
import { exerciseIdArb, FHIR_ID } from './ids.test-helpers.ts'
import { mintResourceId } from './mint-resource-id.ts'

/** A set count, from one up to more sets than two digits number. */
const setsArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 1_000 })

describe('exerciseSetObservationIdOf', () => {
  it('should mint a FHIR id for any exercise and set', () => {
    fc.assert(
      fc.property(exerciseIdArb, setsArb, (exerciseId, sets) => {
        for (const setIndex of [0, sets - 1]) {
          expect(
            exerciseSetObservationIdOf({
              procedureId: mintResourceId(),
              exerciseId,
              setIndex,
              sets,
            })
          ).toMatch(FHIR_ID)
        }
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it("should sort an exercise's set ids in set order", () => {
    fc.assert(
      fc.property(exerciseIdArb, setsArb, (exerciseId, sets) => {
        const procedureId = mintResourceId()
        const setIds = Array.from({ length: sets }, (_, setIndex) =>
          exerciseSetObservationIdOf({ procedureId, exerciseId, setIndex, sets })
        )
        expect(setIds.toSorted()).toEqual(setIds)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should zero-pad the set index to two digits', () => {
    expect(
      exerciseSetObservationIdOf({
        procedureId: 'workout-1',
        exerciseId: 'squat',
        setIndex: 3,
        sets: 5,
      })
    ).toBe('workout-1-squat-03')
  })

  it('should keep two long exercise ids that share a head apart', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{40}$/),
        fc.stringMatching(/^[a-z]{1,8}$/),
        fc.stringMatching(/^[a-z]{1,8}$/),
        (head, leftTail, rightTail) => {
          fc.pre(leftTail !== rightTail)
          const procedureId = mintResourceId()
          const [left, right] = [leftTail, rightTail].map((tail) =>
            exerciseSetObservationIdOf({
              procedureId,
              exerciseId: `${head}-${tail}`,
              setIndex: 0,
              sets: 5,
            })
          )
          expect(left).not.toBe(right)
          expect(left?.length).toBeLessThanOrEqual(FHIR_ID_MAX_LENGTH)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
