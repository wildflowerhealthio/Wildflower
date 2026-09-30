import { Arbitrary, DateTime, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { Code, Quantity, WildflowerExtension } from 'fhir-r4/data-types'
import { ServiceRequest } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import type { Prescription } from '../prescription.ts'
import type { PrescriptionProgress } from '../progression.ts'
import { prescriptionArb } from '../test-helpers.ts'
import { LiftingMeasureCode, planUrlOf } from './elements.ts'
import {
  prescriptionFromFhir,
  prescriptionProgressToFhir,
  prescriptionToFhir,
  revokedRequest,
  type ServiceRequestResource,
} from './prescription.ts'
import { foreignConceptArb, problemsOf, throughWire } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

// Encode → JSON → decode of a whole ServiceRequest is the slow path, so the
// wire round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 50 })

const options = {
  requestId: 'sr-2',
  subject: 'Patient/p-1',
  planUrl: planUrlOf('plan-1'),
  authoredOn: DateTime.unsafeMake('2026-01-05T18:00:00Z'),
  replaces: Option.some('sr-1'),
}

const squat: Prescription = {
  exercise: { id: 'squat', name: 'Squat' },
  load: { value: 135, unit: 'lb' },
  sets: 5,
  reps: 5,
}

const statusArb = Arbitrary.make(ServiceRequest.StatusSchema)

/** A decoded ServiceRequest carrying nothing lifting-specific, for generated fields to be spread onto. */
const shell: ServiceRequestResource = Schema.decodeUnknownSync(ServiceRequest.Schema)({
  resourceType: 'ServiceRequest',
  id: 'foreign',
  status: 'active',
  intent: 'order',
  subject: { reference: 'Patient/p-1' },
})

describe('prescriptionToFhir / prescriptionFromFhir', () => {
  it('should write a squat prescription as an active routine plan ServiceRequest', () => {
    // Act
    const wire = Schema.encodeSync(ServiceRequest.Schema)(prescriptionToFhir(squat, options))

    // Assert
    expect(wire).toMatchObject({
      id: 'sr-2',
      status: 'active',
      intent: 'plan',
      priority: 'routine',
      category: [{ coding: [{ code: 'strength-training' }] }],
      code: { text: 'Squat', coding: [{ code: 'squat', display: 'Squat' }] },
      subject: { reference: 'Patient/p-1' },
      instantiatesCanonical: [planUrlOf('plan-1')],
      replaces: [{ reference: 'ServiceRequest/sr-1' }],
      authoredOn: '2026-01-05T18:00:00.000Z',
    })
    expect(
      wire.orderDetail?.map((detail) => [
        detail.coding?.[0]?.code,
        detail.extension?.[0]?.url,
        detail.extension?.[0]?.valueInteger ?? quantityFields(detail.extension?.[0]?.valueQuantity),
      ])
    ).toEqual([
      [
        LiftingMeasureCode.Load,
        WildflowerExtension.LiftingMeasureValue,
        { value: 135, unit: 'lb', system: 'http://unitsofmeasure.org', code: '[lb_av]' },
      ],
      [LiftingMeasureCode.Sets, WildflowerExtension.LiftingMeasureValue, 5],
      [LiftingMeasureCode.Reps, WildflowerExtension.LiftingMeasureValue, 5],
    ])
  })

  it('should write a kilogram load as UCUM kg', () => {
    const wire = Schema.encodeSync(ServiceRequest.Schema)(
      prescriptionToFhir({ ...squat, load: { value: 60, unit: 'kg' } }, options)
    )
    expect(quantityFields(wire.orderDetail?.[0]?.extension?.[0]?.valueQuantity)).toEqual({
      value: 60,
      unit: 'kg',
      system: 'http://unitsofmeasure.org',
      code: 'kg',
    })
  })

  it('should write no `replaces` for a first prescription', () => {
    expect(prescriptionToFhir(squat, { ...options, replaces: Option.none() }).replaces).toEqual([])
  })

  it('should read back every prescription it writes, with its id, plan and status, through the wire', () => {
    fc.assert(
      fc.property(prescriptionArb, statusArb, (prescription, status) => {
        const written = throughWire(
          ServiceRequest.Schema,
          prescriptionToFhir(prescription, options)
        )
        expect(prescriptionFromFhir({ ...written, status })).toEqual(
          Either.right({ prescription, requestId: 'sr-2', planUrl: planUrlOf('plan-1'), status })
        )
      }),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should refuse a request with no id, or without a single plan url, naming each', () => {
    fc.assert(
      fc.property(
        prescriptionArb,
        fc.boolean(),
        fc.constantFrom('one' as const, 'none' as const, 'two' as const),
        (prescription, idless, urls) => {
          const written = prescriptionToFhir(prescription, options)
          const edited = {
            ...written,
            id: idless ? null : written.id,
            instantiatesCanonical: {
              one: written.instantiatesCanonical,
              none: [],
              two: [...written.instantiatesCanonical, ...written.instantiatesCanonical],
            }[urls],
          }
          expect(problemsOf(prescriptionFromFhir(edited))).toEqual([
            ...(idless ? [{ _tag: 'RequestIdMissing' }] : []),
            ...(urls === 'one' ? [] : [{ _tag: 'PlanUrlUnreadable' }]),
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse a missing or doubled measure, naming it', () => {
    fc.assert(
      fc.property(
        prescriptionArb,
        fc.integer({ min: 0, max: 2 }),
        fc.boolean(),
        (prescription, index, doubled) => {
          // Arrange: the order details are the load, the sets and the reps.
          const written = prescriptionToFhir(prescription, options)
          const edited = {
            ...written,
            orderDetail: doubled
              ? [...written.orderDetail, ...written.orderDetail.slice(index, index + 1)]
              : written.orderDetail.filter((_, at) => at !== index),
          }
          const measure = [
            LiftingMeasureCode.Load,
            LiftingMeasureCode.Sets,
            LiftingMeasureCode.Reps,
          ][index]

          // Act / Assert
          expect(problemsOf(prescriptionFromFhir(edited))).toEqual([
            { _tag: 'MeasureUnreadable', measure },
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse a load with a comparator or in a unit it does not write, and name a negative one out of range', () => {
    fc.assert(
      fc.property(
        prescriptionArb,
        fc.constantFrom('comparator' as const, 'stone' as const, 'negative' as const),
        (prescription, mutation) => {
          // Arrange
          const written = prescriptionToFhir(prescription, options)
          const [load, ...rest] = written.orderDetail
          const [valueExtension] = load?.extension ?? []
          if (load === undefined || valueExtension === undefined)
            throw new Error('the writer emits the load first, with its value extension')
          const quantity = loadQuantityOf(valueExtension.valueQuantity)
          const mutated = {
            comparator: { ...quantity, comparator: '<' as const },
            stone: { ...quantity, code: Code.make('st') },
            negative: { ...quantity, value: -1 - prescription.load.value },
          }[mutation]
          const edited = {
            ...written,
            orderDetail: [
              { ...load, extension: [{ ...valueExtension, valueQuantity: mutated }] },
              ...rest,
            ],
          }

          // Act / Assert
          expect(problemsOf(prescriptionFromFhir(edited))).toEqual([
            mutation === 'negative'
              ? { _tag: 'PrescriptionOutOfRange', field: 'load' }
              : { _tag: 'MeasureUnreadable', measure: LiftingMeasureCode.Load },
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should name zero sets or fractional reps as out of range', () => {
    fc.assert(
      fc.property(
        prescriptionArb,
        fc.constantFrom('sets' as const, 'reps' as const),
        (prescription, field) => {
          // Arrange: the sets and reps are order details 1 and 2.
          const written = prescriptionToFhir(prescription, options)
          const index = field === 'sets' ? 1 : 2
          const bad = field === 'sets' ? 0 : 2.5
          const edited = {
            ...written,
            orderDetail: written.orderDetail.map((detail, at) =>
              at === index
                ? {
                    ...detail,
                    extension: detail.extension.map((extension) => ({
                      ...extension,
                      valueInteger: bad,
                    })),
                  }
                : detail
            ),
          }

          // Act / Assert
          expect(problemsOf(prescriptionFromFhir(edited))).toEqual([
            { _tag: 'PrescriptionOutOfRange', field },
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should ignore order details that measure something foreign', () => {
    fc.assert(
      fc.property(prescriptionArb, fc.array(foreignConceptArb), (prescription, foreign) => {
        const written = prescriptionToFhir(prescription, options)
        const padded = { ...written, orderDetail: [...written.orderDetail, ...foreign] }
        expect(Either.map(prescriptionFromFhir(padded), (stored) => stored.prescription)).toEqual(
          Either.right(prescription)
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a foreign request, reporting every missing part, and name them in the message', () => {
    fc.assert(
      fc.property(foreignConceptArb, (code) => {
        const refused = Either.flip(prescriptionFromFhir({ ...shell, code }))
        expect(Either.map(refused, (unreadable) => unreadable.problems.map((p) => p._tag))).toEqual(
          Either.right([
            'PlanUrlUnreadable',
            'ExerciseUnreadable',
            'MeasureUnreadable',
            'MeasureUnreadable',
            'MeasureUnreadable',
          ])
        )
        expect(Either.map(refused, (unreadable) => unreadable.message)).toEqual(
          Either.right(
            'prescription unreadable: PlanUrlUnreadable; ExerciseUnreadable; MeasureUnreadable {"measure":"load"}; MeasureUnreadable {"measure":"sets"}; MeasureUnreadable {"measure":"reps"}'
          )
        )
      }),
      { numRuns: RUNS }
    )
  })
})

describe('prescriptionProgressToFhir', () => {
  const stepOptions = {
    nextRequestId: 'sr-3',
    authoredOn: DateTime.unsafeMake('2026-01-07T18:00:00Z'),
  }

  it('should complete the current request and issue the next one, replacing it, on an increment', () => {
    // Arrange
    const current = prescriptionToFhir(squat, options)
    const progress: PrescriptionProgress = {
      decision: 'increment',
      next: Option.some({ ...squat, load: { value: 140, unit: 'lb' } }),
    }

    // Act
    const written = Either.getOrThrow(prescriptionProgressToFhir(current, progress, stepOptions))

    // Assert
    expect(written.current).toEqual({ ...current, status: 'completed' })
    const next = Option.getOrThrow(written.next)
    expect(next).toEqual(
      prescriptionToFhir(
        { ...squat, load: { value: 140, unit: 'lb' } },
        {
          requestId: 'sr-3',
          subject: 'Patient/p-1',
          planUrl: planUrlOf('plan-1'),
          authoredOn: stepOptions.authoredOn,
          replaces: Option.some('sr-2'),
        }
      )
    )
  })

  it('should revoke the current request on a deload, and leave it alone on a hold', () => {
    fc.assert(
      fc.property(prescriptionArb, statusArb, fc.boolean(), (prescription, status, deload) => {
        // Arrange
        const current = { ...prescriptionToFhir(prescription, options), status }
        const progress: PrescriptionProgress = deload
          ? { decision: 'deload', next: Option.some(prescription) }
          : { decision: 'hold', next: Option.none() }

        // Act
        const written = Either.getOrThrow(
          prescriptionProgressToFhir(current, progress, stepOptions)
        )

        // Assert
        if (deload) {
          expect(written.current).toEqual({ ...current, status: 'revoked' })
          expect(Option.map(written.next, (next) => [next.id, next.replaces, next.status])).toEqual(
            Option.some([
              'sr-3',
              [{ ...current.replaces[0], reference: 'ServiceRequest/sr-2' }],
              'active',
            ])
          )
        } else {
          expect(written).toEqual({ current, next: Option.none() })
        }
      }),
      { numRuns: RUNS }
    )
  })

  it('should carry the current subject and plan url onto the next request', () => {
    fc.assert(
      fc.property(prescriptionArb, prescriptionArb, (prescription, next) => {
        const current = prescriptionToFhir(prescription, options)
        const written = Either.getOrThrow(
          prescriptionProgressToFhir(
            current,
            { decision: 'increment', next: Option.some(next) },
            stepOptions
          )
        )
        const issued = Option.getOrThrow(written.next)
        expect(issued.subject).toEqual(current.subject)
        expect(issued.instantiatesCanonical).toEqual(current.instantiatesCanonical)
        expect(Either.map(prescriptionFromFhir(issued), (stored) => stored.prescription)).toEqual(
          Either.right(next)
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a current request it cannot read', () => {
    const current = { ...prescriptionToFhir(squat, options), id: null }
    expect(
      problemsOf(
        prescriptionProgressToFhir(current, { decision: 'hold', next: Option.none() }, stepOptions)
      )
    ).toEqual([{ _tag: 'RequestIdMissing' }])
  })
})

describe('revokedRequest', () => {
  it('should change nothing but the status', () => {
    fc.assert(
      fc.property(prescriptionArb, statusArb, (prescription, status) => {
        const current = { ...prescriptionToFhir(prescription, options), status }
        expect(revokedRequest(current)).toEqual({ ...current, status: 'revoked' })
      }),
      { numRuns: RUNS }
    )
  })
})

// Helpers

/** The four fields of an encoded quantity a load is made of, without the empty element slots. */
function quantityFields(quantity: unknown): {
  readonly value: number | null
  readonly unit: string | null
  readonly system: string | null
  readonly code: string | null
} {
  const { value, unit, system, code } = Schema.decodeUnknownSync(Quantity.Schema)(quantity)
  return { value, unit, system, code }
}

/** The load's UCUM quantity, as the writer made it, re-typed from the `any` slot. */
function loadQuantityOf(slot: unknown): Quantity.Type {
  return Schema.decodeUnknownSync(Schema.typeSchema(Quantity.Schema))(slot)
}
