import { Option } from 'effect'

import type * as Report from '../../entities/report.ts'
import { LifeLabsIdentifierSystem } from '../../source-system.ts'
import { parsePrintedDate } from '../dates.ts'
import { sourceId, type Wire } from './shared.ts'

const digitsOf = (text: string): string => text.replaceAll(/\D/g, '')

/**
 * The id the report determines for its patient: the printed `Patient ID`,
 * else the health card number's digits, else the name and date of birth
 * together — the most stable fact the report prints, in that order.
 */
const patientOriginalId = (patient: Report.Type['patient']): string => {
  if (patient.patientId !== '') return sourceId(['patient-id', patient.patientId])
  const healthCard = digitsOf(patient.healthCardNumber)
  if (healthCard !== '') return sourceId(['health-card', healthCard])
  return sourceId(['name', patient.name, patient.dateOfBirth])
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

const patientWire = (report: Report.Type, generalPractitionerId: string | undefined): Wire => {
  const { patient } = report
  const identifier: Wire[] = []
  if (patient.patientId !== '') {
    identifier.push({ system: LifeLabsIdentifierSystem.PatientId, value: patient.patientId })
  }
  if (patient.healthCardNumber !== '') {
    identifier.push({
      system: LifeLabsIdentifierSystem.OntarioHealthCardNumber,
      value: patient.healthCardNumber,
    })
  }
  const wire: Wire = { resourceType: 'Patient', id: patientOriginalId(patient) }
  if (identifier.length > 0) wire['identifier'] = identifier
  if (patient.name !== '') wire['name'] = [humanNameWire(patient.name)]
  const gender = genderOf(patient.sex)
  if (gender !== undefined) wire['gender'] = gender
  const birthDate = parsePrintedDate(patient.dateOfBirth)
  if (Option.isSome(birthDate)) wire['birthDate'] = birthDate.value
  if (patient.phone !== '') wire['telecom'] = [{ system: 'phone', value: patient.phone }]
  if (generalPractitionerId !== undefined) {
    wire['generalPractitioner'] = [{ reference: `Practitioner/${generalPractitionerId}` }]
  }
  return wire
}

export { patientOriginalId, patientWire }
