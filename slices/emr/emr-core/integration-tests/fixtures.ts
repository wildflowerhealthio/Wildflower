import type { Patient, Observation, Binary } from '../src/livestore/index.ts'

type PatientRow = typeof Patient.RowSchema.Type
type ObservationRow = typeof Observation.RowSchema.Type
type BinaryRow = typeof Binary.RowSchema.Type

const blankMeta: PatientRow['meta'] = {
  versionId: '',
  lastUpdated: null,
  source: '',
  profile: [],
  security: [],
  tag: [],
}

interface MakePatientOpts {
  readonly id: string
  readonly active?: PatientRow['active']
  readonly extension?: PatientRow['extension']
  readonly gender?: PatientRow['gender']
  readonly identifier?: PatientRow['identifier']
}

const makePatient = (opts: MakePatientOpts): PatientRow & { readonly id: string } => ({
  resourceType: 'Patient',
  id: opts.id,
  meta: blankMeta,
  implicitRules: null,
  language: null,
  active: opts.active ?? false,
  address: [],
  birthDate: null,
  communication: [],
  contact: [],
  deceasedBoolean: false,
  deceasedDateTime: null,
  gender: opts.gender ?? null,
  generalPractitioner: [],
  identifier: opts.identifier ?? [],
  link: [],
  managingOrganization: null,
  maritalStatus: null,
  multipleBirthBoolean: false,
  multipleBirthInteger: null,
  name: [],
  photo: [],
  telecom: [],
  contained: [],
  extension: opts.extension ?? [],
  modifierExtension: [],
  text: null,
})

interface MakeObservationOpts {
  readonly id: string
  readonly subjectReference?: string | null
}

const blankCode: ObservationRow['code'] = { id: null, extension: [], coding: [], text: null }

const makeObservation = (opts: MakeObservationOpts): ObservationRow & { readonly id: string } => {
  let subject: ObservationRow['subject'] = null
  if (opts.subjectReference !== undefined && opts.subjectReference !== null) {
    subject = {
      id: null,
      extension: [],
      display: null,
      reference: opts.subjectReference,
      type: null,
      identifier: null,
    }
  }
  return {
    resourceType: 'Observation',
    id: opts.id,
    meta: blankMeta,
    implicitRules: null,
    language: null,
    contained: [],
    extension: [],
    modifierExtension: [],
    text: null,
    basedOn: [],
    bodySite: null,
    category: [],
    code: blankCode,
    component: [],
    dataAbsentReason: null,
    derivedFrom: [],
    device: null,
    effectiveDateTime: null,
    effectivePeriod: null,
    effectiveTiming: null,
    effectiveInstant: null,
    encounter: null,
    focus: [],
    hasMember: [],
    identifier: [],
    interpretation: [],
    issued: null,
    method: null,
    note: [],
    partOf: [],
    performer: [],
    referenceRange: [],
    specimen: null,
    status: 'final',
    subject,
    valueQuantity: null,
    valueCodeableConcept: null,
    valueString: null,
    valueBoolean: null,
    valueInteger: null,
    valueRange: null,
    valueRatio: null,
    valueSampledData: null,
    valueTime: null,
    valueDateTime: null,
    valuePeriod: null,
  }
}

export { makePatient, makeObservation }
export type { PatientRow, ObservationRow, BinaryRow }
