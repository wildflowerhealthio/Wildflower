import { HealthCardIdentifier, type HealthCardProvince } from '@wildflowerhealthio/fhir-ca-infoway'
import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Array as Arr, Option } from 'effect'

import type * as Report from '../../entities/report.ts'
import { LifeLabsIdentifierSystem } from '../../source-system.ts'
import { parsePrintedDate } from '../dates.ts'
import type { Wire } from './shared.ts'

/** An identifier the synthesis writes for the patient: always with its `system` and `value`. */
type PatientIdentifier = DetachedResource.Key &
  typeof IdentifierAndReference.IdentifierSchema.Encoded

/**
 * The identifiers the report prints for its patient: `Patient ID` as printed,
 * then `HC #` as `healthCardProvince` writes it.
 */
const printedIdentifiersOf = (
  patient: Report.Type['patient'],
  healthCardProvince: HealthCardProvince.Type
): PatientIdentifier[] => [
  ...(patient.patientId === ''
    ? []
    : [{ system: LifeLabsIdentifierSystem.PatientId, value: patient.patientId }]),
  ...(patient.healthCardNumber === ''
    ? []
    : [HealthCardIdentifier.of(healthCardProvince, patient.healthCardNumber)]),
]

/**
 * The patient's identifiers, its key first: the identifiers the report
 * prints, else the name and date of birth as printed,
 * `<name>, <date of birth>`.
 */
const patientIdentifiersOf = (
  patient: Report.Type['patient'],
  healthCardProvince: HealthCardProvince.Type
): Arr.NonEmptyReadonlyArray<PatientIdentifier> =>
  Arr.match(printedIdentifiersOf(patient, healthCardProvince), {
    onEmpty: () =>
      Arr.of({
        system: LifeLabsIdentifierSystem.PatientNameBirthDate,
        value: `${patient.name.trim()}, ${patient.dateOfBirth}`,
      }),
    onNonEmpty: (identifiers) => identifiers,
  })

/**
 * The key the report gives its patient: the printed `Patient ID`, else the
 * health card number (Ontario's less its version code, so a reissued card
 * keys the same Patient), else the name and date of birth as printed.
 */
const patientKeyOf = (
  patient: Report.Type['patient'],
  healthCardProvince: HealthCardProvince.Type
): DetachedResource.Key => {
  const { system, value } = Arr.headNonEmpty(patientIdentifiersOf(patient, healthCardProvince))
  return { system, value }
}

/** `FAMILY, GIVEN GIVEN` → a HumanName; any other shape becomes `text`. */
const humanNameWire = (printed: string): Wire => {
  const [family, given] = printed.split(',', 2).map((part) => part.trim())
  if (family !== undefined && given !== undefined && family.length > 0) {
    return { family, given: given.split(/\s+/).filter((part) => part.length > 0), text: printed }
  }
  return { text: printed }
}

const genderOf = (sex: string): string | undefined => {
  switch (sex.trim().toUpperCase()) {
    case 'F':
      return 'female'
    case 'M':
      return 'male'
    default:
      return undefined
  }
}

const patientWire = (report: Report.Type, healthCardProvince: HealthCardProvince.Type): Wire => {
  const { patient } = report
  const wire: Wire = {
    resourceType: 'Patient',
    identifier: patientIdentifiersOf(patient, healthCardProvince),
  }
  if (patient.name !== '') wire['name'] = [humanNameWire(patient.name)]
  const gender = genderOf(patient.sex)
  if (gender !== undefined) wire['gender'] = gender
  const birthDate = parsePrintedDate(patient.dateOfBirth)
  if (Option.isSome(birthDate)) wire['birthDate'] = birthDate.value
  if (patient.phone !== '') wire['telecom'] = [{ system: 'phone', value: patient.phone }]
  return wire
}

export { patientKeyOf, patientWire }
