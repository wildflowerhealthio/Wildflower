import {
  Dosage,
  Duration,
  Period,
  Quantity,
  SimpleQuantity,
  Timing,
} from '@wildflowerhealthio/fhir-r4/data-types'
import {
  MedicationRequest,
  MedicationRequestDispenseRequest,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'

import type { MedicationRequestWithId } from './medication-request-with-id.ts'

/**
 * Whole generated requests, as the base every dose-regimen property overlays.
 *
 * @remarks
 * A whole-schema `MedicationRequest` costs well over 100 ms to generate — far
 * too much per run — so a seeded pool of them is sampled once and drawn from.
 * `extension` is pinned empty: it is recursive and nothing here reads it.
 */
const wholeRequests = fc
  .sample(Arbitrary.make(MedicationRequest.Schema), { numRuns: 8, seed: 579 })
  .map((request) => ({ ...request, extension: [] }))

/** Hand-built wire quantities, decoded for the `dispenseRequest` slots. */
const decodeQuantity = Schema.decodeUnknownSync(Quantity.Schema)
const decodeDuration = Schema.decodeUnknownSync(Duration.Schema)

/** A dosage carrying nothing, for the generated timing and dose to be spread onto. */
const emptyDosage = Schema.decodeUnknownSync(Dosage.Schema)({})

/**
 * A contained Medication ingredient as wire JSON, whose strength is mostly one
 * dispensed unit (`denominator.value` 1, with no unit or a dispensed unit) and
 * sometimes not.
 */
const ingredientArb = fc.record({
  itemCodeableConcept: fc.constant({ text: 'Drug' }),
  strength: fc.record({
    numerator: fc.record({
      value: fc.double({ min: 0.001, max: 1000, noNaN: true }),
      unit: fc.constantFrom('mg', 'mL'),
    }),
    denominator: fc.record(
      {
        value: fc.constantFrom(1, 1, 1, 2),
        unit: fc.constantFrom('capsule', 'tablet'),
      },
      { requiredKeys: ['value'] }
    ),
  }),
})

/**
 * A contained Medication as wire JSON, mostly with the single ingredient an
 * amortized dose is scaled by, else with none or two, so the amortized dose is
 * both scaled by strength and left in dispensed units.
 */
const containedMedicationArb = fc.record({
  resourceType: fc.constant('Medication'),
  ingredient: fc.oneof(
    { arbitrary: fc.tuple(ingredientArb), weight: 3 },
    { arbitrary: fc.array(ingredientArb, { maxLength: 2 }), weight: 1 }
  ),
})

/**
 * A whole request with an `id` and the slots the dose-regimen readers read
 * overlaid by targeted arbitraries, so a dose, a schedule, a status, a
 * dispensed supply and a dispense window vary on every run and every branch is
 * reached — including requests that state no dose, as pharmacy imports do.
 */
const medicationRequestWithIdArb: fc.Arbitrary<MedicationRequestWithId> = fc
  .record({
    wholeRequest: fc.constantFrom(...wholeRequests),
    id: fc.uuid(),
    status: Arbitrary.make(MedicationRequest.StatusSchema),
    authoredOn: fc.option(Arbitrary.make(Schema.DateTimeUtc), { nil: null }),
    doseAndRate: Arbitrary.make(Dosage.DosageDoseAndRateSchema),
    // Mostly a valued quantity, so most runs reach a regimen; the generated
    // `doseAndRate` supplies the null-quantity and dose-range cases.
    doseQuantity: fc.option(
      Arbitrary.make(SimpleQuantity.Schema).map((quantity) => ({
        ...quantity,
        value: quantity.value ?? 1,
      })),
      { freq: 4, nil: null }
    ),
    timing: Arbitrary.make(Timing.Schema),
    timingRepeat: Arbitrary.make(Timing.TimingRepeatSchema),
    validityPeriod: fc.option(Arbitrary.make(Period.Schema), { nil: null }),
    // Often a usable day count, so a supply end and an amortized dose are
    // reached; the generated duration supplies the unusable cases.
    expectedSupplyDuration: fc.option(
      fc.oneof(
        Arbitrary.make(Duration.Schema),
        fc
          .record({ value: fc.integer({ min: 1, max: 90 }), code: fc.constant('d') })
          .map(decodeDuration)
      ),
      { nil: null }
    ),
    numberOfRepeatsAllowed: fc.option(fc.nat(12), { nil: null }),
    // Mostly a positive quantity, so the amortized dose is often reached; the
    // generated quantity supplies the null, zero and negative cases.
    dispensedQuantity: fc.option(
      fc.oneof(
        Arbitrary.make(Quantity.Schema),
        fc
          .record({
            value: fc.integer({ min: 1, max: 500 }),
            unit: fc.constantFrom('capsule', 'tablet'),
          })
          .map(decodeQuantity)
      ),
      { nil: null }
    ),
    // Some requests state no dose at all, as a pharmacy import's empty
    // `dosageInstruction` does.
    statesDose: fc.boolean(),
    containedMedication: fc.option(containedMedicationArb, { nil: null }),
  })
  .map(
    ({
      wholeRequest,
      id,
      status,
      authoredOn,
      doseAndRate,
      doseQuantity,
      timing,
      timingRepeat,
      validityPeriod,
      expectedSupplyDuration,
      numberOfRepeatsAllowed,
      dispensedQuantity,
      statesDose,
      containedMedication,
    }) => ({
      ...wholeRequest,
      id,
      status,
      authoredOn,
      contained: containedMedication === null ? wholeRequest.contained : [containedMedication],
      dosageInstruction: statesDose
        ? [
            {
              ...emptyDosage,
              doseAndRate: [doseQuantity === null ? doseAndRate : { ...doseAndRate, doseQuantity }],
              timing: { ...timing, repeat: timingRepeat },
            },
            ...wholeRequest.dosageInstruction,
          ]
        : [],
      dispenseRequest: {
        ...MedicationRequestDispenseRequest.empty,
        validityPeriod,
        expectedSupplyDuration,
        numberOfRepeatsAllowed,
        quantity: dispensedQuantity,
      },
    })
  )

export { medicationRequestWithIdArb }
