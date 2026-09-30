import { Arbitrary, DateTime, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { Period } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { SetResult } from '../set-result.ts'
import { exerciseArb, instantArb, workoutLabelArb } from '../test-helpers.ts'
import { referenceTo } from './elements.ts'
import {
  type ObservationResource,
  setResultFromFhir,
  setResultToFhir,
  type StoredSetResult,
} from './set-result.ts'
import { foreignConceptArb, problemsOf, throughWire } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

// Encode → JSON → decode of a whole Observation is the slow path, so the wire
// round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 50 })

const options = { observationId: 'obs-1', subject: 'Patient/p-1', requestId: 'sr-2' }

/** Any set: a start, a length up to ten minutes, and any count of reps. */
const setArb: fc.Arbitrary<SetResult> = fc
  .record({
    exercise: exerciseArb,
    workoutLabel: workoutLabelArb,
    start: instantArb,
    lengthMillis: fc.nat({ max: 600_000 }),
    reps: fc.nat({ max: 30 }),
  })
  .map(({ lengthMillis, ...set }) => ({
    ...set,
    end: DateTime.addDuration(set.start, `${lengthMillis} millis`),
  }))

const statusArb = Arbitrary.make(Observation.StatusSchema)

/** A decoded Observation carrying nothing lifting-specific, for generated fields to be spread onto. */
const shell: ObservationResource = Schema.decodeUnknownSync(Observation.Schema)({
  resourceType: 'Observation',
  status: 'final',
  code: { text: 'Heart rate' },
})

describe('setResultToFhir / setResultFromFhir', () => {
  it('should write a squat set as a final activity Observation based on its request', () => {
    // Arrange
    const set: SetResult = {
      exercise: { id: 'squat', name: 'Squat' },
      workoutLabel: 'A',
      start: DateTime.unsafeMake('2026-01-05T18:00:00Z'),
      end: DateTime.unsafeMake('2026-01-05T18:00:40Z'),
      reps: 4,
    }

    // Act
    const wire = Schema.encodeSync(Observation.Schema)(setResultToFhir(set, options))

    // Assert
    expect(wire).toMatchObject({
      id: 'obs-1',
      status: 'final',
      category: [
        {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/observation-category',
              code: 'activity',
            },
          ],
        },
      ],
      code: { text: 'Squat', coding: [{ code: 'squat', display: 'Squat' }] },
      subject: { reference: 'Patient/p-1' },
      basedOn: [{ reference: 'ServiceRequest/sr-2' }],
      effectivePeriod: { start: '2026-01-05T18:00:00.000Z', end: '2026-01-05T18:00:40.000Z' },
      valueInteger: 4,
      extension: [{ valueString: 'A' }],
    })
    expect(wire.component).toEqual([])
  })

  it('should read back every set it writes, with its request, through the encoded wire form', () => {
    fc.assert(
      fc.property(setArb, (set) => {
        // Act
        const read = setResultFromFhir(
          throughWire(Observation.Schema, setResultToFhir(set, options))
        )

        // Assert
        expect(Either.map(read, Option.map(comparable))).toEqual(
          Either.right(Option.some(comparable({ set, requestId: 'sr-2' })))
        )
      }),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should read nothing from a retracted observation, and the set from any other status', () => {
    fc.assert(
      fc.property(setArb, statusArb, fc.boolean(), (set, status, broken) => {
        // Arrange
        const written = setResultToFhir(set, options)
        const observation = { ...written, status, extension: broken ? [] : written.extension }

        // Act
        const read = setResultFromFhir(observation)

        // Assert
        if (Observation.RETRACTED_STATUSES.has(status))
          expect(read).toEqual(Either.right(Option.none()))
        else if (broken) expect(problemsOf(read)).toEqual([{ _tag: 'WorkoutLabelUnreadable' }])
        else
          expect(Either.map(read, Option.map(comparable))).toEqual(
            Either.right(Option.some(comparable({ set, requestId: 'sr-2' })))
          )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a period missing either end, or ending before it starts', () => {
    fc.assert(
      fc.property(
        setArb,
        fc.constantFrom(
          'none' as const,
          'startOnly' as const,
          'endOnly' as const,
          'backwards' as const
        ),
        (set, mutation) => {
          // Arrange
          const written = setResultToFhir(set, options)
          const period = periodOf(written)
          const effectivePeriod = {
            none: null,
            startOnly: { ...period, end: null },
            endOnly: { ...period, start: null },
            backwards: { ...period, start: DateTime.addDuration(set.end, '1 millis') },
          }[mutation]

          // Act / Assert
          expect(problemsOf(setResultFromFhir({ ...written, effectivePeriod }))).toEqual([
            { _tag: 'PeriodUnreadable' },
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse reps that are missing, negative or fractional', () => {
    fc.assert(
      fc.property(setArb, fc.constantFrom(null, -1, 2.5), (set, valueInteger) => {
        const written = setResultToFhir(set, options)
        expect(problemsOf(setResultFromFhir({ ...written, valueInteger }))).toEqual([
          { _tag: 'RepsUnreadable' },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a set without a single ServiceRequest among its basedOn', () => {
    fc.assert(
      fc.property(
        setArb,
        fc.constantFrom('none' as const, 'two' as const, 'carePlan' as const),
        (set, mutation) => {
          const written = setResultToFhir(set, options)
          const basedOn = {
            none: [],
            two: [...written.basedOn, referenceTo('ServiceRequest', 'sr-9')],
            carePlan: [referenceTo('CarePlan', 'cp-1')],
          }[mutation]
          expect(problemsOf(setResultFromFhir({ ...written, basedOn }))).toEqual([
            { _tag: 'RequestUnreadable' },
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should read the request beside references to other resources', () => {
    fc.assert(
      fc.property(setArb, (set) => {
        const written = setResultToFhir(set, options)
        const padded = {
          ...written,
          basedOn: [referenceTo('CarePlan', 'cp-1'), ...written.basedOn],
        }
        expect(
          Either.map(
            setResultFromFhir(padded),
            Option.map((stored) => stored.requestId)
          )
        ).toEqual(Either.right(Option.some('sr-2')))
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a set whose exercise coding has no display', () => {
    fc.assert(
      fc.property(setArb, (set) => {
        const written = setResultToFhir(set, options)
        const nameless = {
          ...written,
          code: {
            ...written.code,
            coding: written.code.coding.map((coding) => ({ ...coding, display: null })),
          },
        }
        expect(problemsOf(setResultFromFhir(nameless))).toEqual([{ _tag: 'ExerciseUnreadable' }])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a foreign observation, reporting every missing part, and name them in the message', () => {
    fc.assert(
      fc.property(foreignConceptArb, (code) => {
        const refused = Either.flip(setResultFromFhir({ ...shell, code }))
        expect(Either.map(refused, (unreadable) => unreadable.problems.map((p) => p._tag))).toEqual(
          Either.right([
            'ExerciseUnreadable',
            'WorkoutLabelUnreadable',
            'PeriodUnreadable',
            'RepsUnreadable',
            'RequestUnreadable',
          ])
        )
        expect(Either.map(refused, (unreadable) => unreadable.message)).toEqual(
          Either.right(
            'set unreadable: ExerciseUnreadable; WorkoutLabelUnreadable; PeriodUnreadable; RepsUnreadable; RequestUnreadable'
          )
        )
      }),
      { numRuns: RUNS }
    )
  })
})

// Helpers

/** The written `effectivePeriod`, re-typed from the `any` slot. */
function periodOf(observation: ObservationResource): typeof Period.Schema.Type {
  return Schema.decodeUnknownSync(Schema.typeSchema(Period.Schema))(observation.effectivePeriod)
}

/** A stored set with its instants as epoch millis, so equality does not depend on DateTime's cached fields. */
function comparable(stored: StoredSetResult): {
  readonly requestId: string
  readonly set: Omit<SetResult, 'start' | 'end'> & { readonly start: number; readonly end: number }
} {
  return {
    requestId: stored.requestId,
    set: {
      ...stored.set,
      start: DateTime.toEpochMillis(stored.set.start),
      end: DateTime.toEpochMillis(stored.set.end),
    },
  }
}
