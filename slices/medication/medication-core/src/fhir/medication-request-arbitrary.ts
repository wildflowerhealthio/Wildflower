import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { Dosage, Duration, Period, SimpleQuantity, Timing } from 'fhir-r4/data-types'
import { MedicationRequest, MedicationRequestDispenseRequest } from 'fhir-r4/resources'

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

/** A dosage carrying nothing, for the generated timing and dose to be spread onto. */
const emptyDosage = Schema.decodeUnknownSync(Dosage.Schema)({})

/**
 * A whole request with an `id` and the slots the dose-regimen readers read
 * overlaid by targeted arbitraries, so a dose, a schedule, a status and a
 * dispense window vary on every run and every branch is reached.
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
    expectedSupplyDuration: fc.option(Arbitrary.make(Duration.Schema), { nil: null }),
    numberOfRepeatsAllowed: fc.option(fc.nat(12), { nil: null }),
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
    }) => ({
      ...wholeRequest,
      id,
      status,
      authoredOn,
      dosageInstruction: [
        {
          ...emptyDosage,
          doseAndRate: [doseQuantity === null ? doseAndRate : { ...doseAndRate, doseQuantity }],
          timing: { ...timing, repeat: timingRepeat },
        },
        ...wholeRequest.dosageInstruction,
      ],
      dispenseRequest: {
        ...MedicationRequestDispenseRequest.empty,
        validityPeriod,
        expectedSupplyDuration,
        numberOfRepeatsAllowed,
      },
    })
  )

export { medicationRequestWithIdArb }
