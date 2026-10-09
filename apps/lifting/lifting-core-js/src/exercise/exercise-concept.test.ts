import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { CodeableConcept, WildflowerCodeSystem } from 'fhir-r4/data-types'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  exerciseConceptArb,
  exerciseIdArb,
  issuePathsOf,
  made,
  nonEmptyTrimmedStringArb,
  throughWire,
} from '../test-helpers.ts'
import * as ExerciseConcept from './exercise-concept.ts'

const RUNS = numRunsFor({ base: 100 })

/** An exercise concept as the wire carries it: a `CodeableConcept`, decoded and then narrowed. */
const WireExerciseConcept = Schema.compose(CodeableConcept.Schema, ExerciseConcept.Schema)

describe('ExerciseConcept', () => {
  it('should code the squat under the exercise system, its name the display and the text', () => {
    const wire = Schema.encodeSync(WireExerciseConcept)(
      made(ExerciseConcept.make({ id: 'squat', name: 'Squat' }))
    )
    expect(wire).toMatchObject({
      text: 'Squat',
      coding: [{ system: WildflowerCodeSystem.Exercise, code: 'squat', display: 'Squat' }],
    })
  })

  it('should read back the id and name of every exercise it makes, through the wire', () => {
    fc.assert(
      fc.property(exerciseIdArb, nonEmptyTrimmedStringArb, (id, name) => {
        const concept = throughWire(WireExerciseConcept, made(ExerciseConcept.make({ id, name })))
        expect([ExerciseConcept.idOf(concept), ExerciseConcept.nameOf(concept)]).toEqual([id, name])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse an id that is not a slug and an empty or untrimmed name, naming both', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', ' ', 'Bench Press', '-squat', 'squat--row', 'Squat'),
        fc.constantFrom('', ' ', '\t', ' Squat', 'Squat\n'),
        (id, name) => {
          expect(issuePathsOf(ExerciseConcept.make({ id, name }))).toEqual([
            'coding.0.code',
            'coding.0.display',
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should read an exercise beside codings in other systems, and refuse none or two', () => {
    fc.assert(
      fc.property(exerciseConceptArb, fc.webUrl(), (exercise, otherSystem) => {
        // Arrange
        const [foreign] = CodeableConcept.make({
          system: otherSystem,
          code: 'x',
          display: null,
          text: null,
        }).coding
        if (foreign === undefined) throw new Error('make writes one coding')
        const decode = Schema.decodeEither(ExerciseConcept.Schema)

        // Act / Assert
        expect(
          Either.map(
            decode({ ...exercise, coding: [foreign, ...exercise.coding] }),
            ExerciseConcept.idOf
          )
        ).toEqual(Either.right(ExerciseConcept.idOf(exercise)))
        expect(issuePathsOf(decode({ ...exercise, coding: [foreign] }))).toEqual(['coding'])
        expect(
          issuePathsOf(decode({ ...exercise, coding: [...exercise.coding, ...exercise.coding] }))
        ).toEqual(['coding'])
      }),
      { numRuns: RUNS }
    )
  })
})

describe('idFromName', () => {
  it('should slug display names the way exercise ids are spelled', () => {
    expect(ExerciseConcept.idFromName('Bench Press')).toBe('bench-press')
    expect(ExerciseConcept.idFromName('  Développé  Couché! ')).toBe('developpe-couche')
    expect(ExerciseConcept.idFromName('Romanian Deadlift (RDL)')).toBe('romanian-deadlift-rdl')
  })

  it('should produce only lowercase letters, digits and single inner hyphens', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (name) => {
        expect(ExerciseConcept.idFromName(name)).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/)
      }),
      { numRuns: RUNS }
    )
  })

  it('should leave its own output unchanged', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (name) => {
        const id = ExerciseConcept.idFromName(name)
        expect(ExerciseConcept.idFromName(id)).toBe(id)
      }),
      { numRuns: RUNS }
    )
  })
})
