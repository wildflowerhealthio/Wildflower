import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Array as Arr, Option } from 'effect'

import type * as Report from '../../entities/report.ts'
import { LifeLabsIdentifierSystem } from '../../source-system.ts'
import { parsePrintedDate } from '../dates.ts'
import type { Wire } from './shared.ts'

/**
 * A printed Ontario health card number less its version code: the one or two
 * letters after the number, and any whitespace before them (`1234567890 AB` →
 * `1234567890`).
 *
 * @remarks
 * The version code changes when a card is reissued, and the number names the
 * person, so two reports printing one number under different version codes
 * key one Patient. The rest is kept as printed.
 */
const healthCardNumberWithoutVersionCode = (printed: string): string =>
  printed.replace(/(?<=\d)\s*[A-Za-z]{1,2}$/, '')

/**
 * The identifiers the report prints for its patient: `Patient ID` as printed,
 * then `HC #` less its version code.
 */
const printedIdentifiersOf = (patient: Report.Type['patient']): DetachedResource.Key[] => [
  ...(patient.patientId === ''
    ? []
    : [{ system: LifeLabsIdentifierSystem.PatientId, value: patient.patientId }]),
  ...(patient.healthCardNumber === ''
    ? []
    : [
        {
          system: LifeLabsIdentifierSystem.OntarioHealthCardNumber,
          value: healthCardNumberWithoutVersionCode(patient.healthCardNumber),
        },
      ]),
]

/**
 * The key the report gives its patient: the printed `Patient ID`, else the
 * health card number less its version code, else the name and date of birth
 * as printed, `<name>, <date of birth>`.
 */
const patientKeyOf = (patient: Report.Type['patient']): DetachedResource.Key =>
  Option.getOrElse(Arr.head(printedIdentifiersOf(patient)), () => ({
    system: LifeLabsIdentifierSystem.PatientNameBirthDate,
    value: `${patient.name.trim()}, ${patient.dateOfBirth}`,
  }))

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

const patientWire = (report: Report.Type): Wire => {
  const { patient } = report
  const key = patientKeyOf(patient)
  // The key first, then every other identifier the report prints.
  const wire: Wire = {
    resourceType: 'Patient',
    identifier: [
      DetachedResource.keyIdentifierWire(key),
      ...printedIdentifiersOf(patient)
        .filter(({ system }) => system !== key.system)
        .map(DetachedResource.keyIdentifierWire),
    ],
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
