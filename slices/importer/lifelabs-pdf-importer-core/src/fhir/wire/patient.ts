import { HealthCardIdentifier, type HealthCardProvince } from '@wildflowerhealthio/fhir-ca-infoway'
import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Array as Arr, Effect, Option, type ParseResult, Schema } from 'effect'

import type * as Report from '../../entities/report.ts'
import { LifeLabsIdentifierSystem } from '../../source-system.ts'
import { parsePrintedDate } from '../dates.ts'
import type { Wire } from './shared.ts'

/**
 * An identifier the synthesis writes for the patient: an `Identifier` wire
 * with its `system` and `value` always set, the shape a health card number is
 * written in, so the patient's key can be read off any of them.
 */
type PatientIdentifier = HealthCardIdentifier.Type

/**
 * The identifiers the report prints for its patient: `Patient ID` as printed,
 * then `HC #` decoded by `healthCardProvince`'s rule; fails with a
 * `ParseError` when the `HC #` is not that province's shape.
 */
const printedIdentifiersOf = (
  patient: Report.Type['patient'],
  healthCardProvince: HealthCardProvince.Type
): Effect.Effect<PatientIdentifier[], ParseResult.ParseError> =>
  Effect.gen(function* () {
    const patientIds =
      patient.patientId === ''
        ? []
        : [{ system: LifeLabsIdentifierSystem.PatientId, value: patient.patientId }]
    const healthCards =
      patient.healthCardNumber === ''
        ? []
        : [
            yield* Schema.decode(HealthCardIdentifier.FromPrinted(healthCardProvince))(
              patient.healthCardNumber
            ),
          ]
    return [...patientIds, ...healthCards]
  })

/**
 * The patient's identifiers, its key first: the identifiers the report
 * prints, else the name and date of birth as printed,
 * `<name>, <date of birth>`.
 */
const patientIdentifiersOf = (
  patient: Report.Type['patient'],
  healthCardProvince: HealthCardProvince.Type
): Effect.Effect<Arr.NonEmptyReadonlyArray<PatientIdentifier>, ParseResult.ParseError> =>
  Effect.map(printedIdentifiersOf(patient, healthCardProvince), (printed) =>
    Arr.match(printed, {
      onEmpty: () =>
        Arr.of({
          system: LifeLabsIdentifierSystem.PatientNameBirthDate,
          value: `${patient.name.trim()}, ${patient.dateOfBirth}`,
        }),
      onNonEmpty: (identifiers) => identifiers,
    })
  )

/**
 * The key the report gives its patient: the printed `Patient ID`, else the
 * health card number (Ontario's less its version code, so a reissued card
 * keys the same Patient), else the name and date of birth as printed; fails
 * with a `ParseError` when the `HC #` is not `healthCardProvince`'s shape.
 */
const patientKeyOf = (
  patient: Report.Type['patient'],
  healthCardProvince: HealthCardProvince.Type
): Effect.Effect<DetachedResource.Key, ParseResult.ParseError> =>
  Effect.map(patientIdentifiersOf(patient, healthCardProvince), (identifiers) => {
    const { system, value } = Arr.headNonEmpty(identifiers)
    return { system, value }
  })

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

/**
 * The Patient `report`'s patient block describes; fails with a `ParseError`
 * when its `HC #` is not `healthCardProvince`'s shape.
 */
const patientWire = (
  report: Report.Type,
  healthCardProvince: HealthCardProvince.Type
): Effect.Effect<Wire, ParseResult.ParseError> =>
  Effect.gen(function* () {
    const { patient } = report
    const wire: Wire = {
      resourceType: 'Patient',
      identifier: yield* patientIdentifiersOf(patient, healthCardProvince),
    }
    if (patient.name !== '') wire['name'] = [humanNameWire(patient.name)]
    const gender = genderOf(patient.sex)
    if (gender !== undefined) wire['gender'] = gender
    const birthDate = parsePrintedDate(patient.dateOfBirth)
    if (Option.isSome(birthDate)) wire['birthDate'] = birthDate.value
    if (patient.phone !== '') wire['telecom'] = [{ system: 'phone', value: patient.phone }]
    return wire
  })

export { patientKeyOf, patientWire }
