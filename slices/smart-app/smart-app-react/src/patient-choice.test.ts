import { Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  ALL_PATIENTS_PARAM_VALUE,
  decodePatientChoice,
  PATIENT_PARAM,
  type PatientChoice,
  patientChoiceKeyOf,
  patientScopeOf,
  withPatientChoice,
} from './patient-choice.ts'

const RUNS = numRunsFor({ base: 200 })

/** A FHIR logical id: what a picked patient's id always is. */
const fhirIdArb = fc.stringMatching(/^[A-Za-z0-9\-.]{1,64}$/)

const patientChoiceArb: fc.Arbitrary<PatientChoice> = fc.oneof(
  fhirIdArb.map((patientId): PatientChoice => ({ kind: 'patient', patientId })),
  fc.constant<PatientChoice>({ kind: 'all-patients' })
)

/** Query parameters an app's own URL state might hold beside the choice. */
const otherParamsArb: fc.Arbitrary<URLSearchParams> = fc
  .array(
    fc.tuple(
      fc.string({ maxLength: 8 }).filter((key) => key !== PATIENT_PARAM),
      fc.string({ maxLength: 8 })
    ),
    { maxLength: 6 }
  )
  .map((entries) => new URLSearchParams(entries))

describe('withPatientChoice / decodePatientChoice', () => {
  test('decode reads back the choice written, through an actual query string', () => {
    fc.assert(
      fc.property(otherParamsArb, patientChoiceArb, (otherParams, patientChoice) => {
        const query = withPatientChoice(otherParams, patientChoice).toString()
        expect(decodePatientChoice(new URLSearchParams(query))).toEqual(Option.some(patientChoice))
      }),
      { numRuns: RUNS }
    )
  })

  test('every other query key is kept, in order, and the input is not changed', () => {
    fc.assert(
      fc.property(otherParamsArb, patientChoiceArb, (otherParams, patientChoice) => {
        const before = otherParams.toString()
        const written = withPatientChoice(otherParams, patientChoice)
        written.delete(PATIENT_PARAM)
        expect(written.toString()).toBe(before)
        expect(otherParams.toString()).toBe(before)
      }),
      { numRuns: RUNS }
    )
  })

  test('a later choice replaces an earlier one rather than adding a second', () => {
    fc.assert(
      fc.property(patientChoiceArb, patientChoiceArb, (earlierChoice, laterChoice) => {
        const written = withPatientChoice(
          withPatientChoice(new URLSearchParams(), earlierChoice),
          laterChoice
        )
        expect(written.getAll(PATIENT_PARAM)).toHaveLength(1)
        expect(decodePatientChoice(written)).toEqual(Option.some(laterChoice))
      }),
      { numRuns: RUNS }
    )
  })

  test('every patient is written as `*`', () => {
    expect(
      withPatientChoice(new URLSearchParams(), { kind: 'all-patients' }).get(PATIENT_PARAM)
    ).toBe(ALL_PATIENTS_PARAM_VALUE)
  })

  test('an absent or empty patient is no choice yet', () => {
    expect(decodePatientChoice(new URLSearchParams('code=abc&state=xyz'))).toEqual(Option.none())
    expect(decodePatientChoice(new URLSearchParams(`${PATIENT_PARAM}=`))).toEqual(Option.none())
  })

  test('arbitrary query strings decode to something rather than throwing', () => {
    fc.assert(
      fc.property(fc.string(), (query) => {
        expect(() => decodePatientChoice(new URLSearchParams(query))).not.toThrow()
      }),
      { numRuns: RUNS }
    )
  })
})

describe('patientScopeOf', () => {
  test("is the patient's id for one patient, and null for every patient", () => {
    expect(patientScopeOf({ kind: 'patient', patientId: 'p1' })).toBe('p1')
    expect(patientScopeOf({ kind: 'all-patients' })).toBeNull()
  })
})

describe('patientChoiceKeyOf', () => {
  test('tells every two different choices apart', () => {
    fc.assert(
      fc.property(patientChoiceArb, patientChoiceArb, (left, right) => {
        expect(patientChoiceKeyOf(left) === patientChoiceKeyOf(right)).toBe(
          JSON.stringify(left) === JSON.stringify(right)
        )
      }),
      { numRuns: RUNS }
    )
  })
})
