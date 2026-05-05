import type { Observation as StoreObservation, Patient as StorePatient } from 'emr-core/livestore'

// HttpApiClient's `setPayload(schema)` accepts the schema's *Type* (decoded)
// shape and encodes it on the wire. fhir-r4's resource schemas are
// `Schema<StoreType, FhirJson, never>` — so client callers pass StoreType,
// not the wire FhirR4 shape. These fixtures produce Type-side rows.

type PatientRow = typeof StorePatient.RowSchema.Type
type ObservationRow = typeof StoreObservation.RowSchema.Type

const blankMeta: PatientRow['meta'] = {
  versionId: '',
  lastUpdated: null,
  source: '',
  profile: [],
  security: [],
  tag: [],
}

const defaultName: PatientRow['name'] = [
  {
    id: null,
    extension: [],
    family: 'Doe',
    given: ['Jane'],
    use: null,
    text: null,
    prefix: [],
    suffix: [],
    period: null,
  },
]

const samplePatient = (
  id: string,
  overrides: Partial<PatientRow> = {}
): PatientRow & { readonly id: string } => ({
  resourceType: 'Patient',
  id,
  meta: blankMeta,
  implicitRules: null,
  language: null,
  active: true,
  address: [],
  birthDate: null,
  communication: [],
  contact: [],
  deceasedBoolean: false,
  deceasedDateTime: null,
  gender: 'female',
  generalPractitioner: [],
  identifier: [],
  link: [],
  managingOrganization: null,
  maritalStatus: null,
  multipleBirthBoolean: false,
  multipleBirthInteger: null,
  name: defaultName,
  photo: [],
  telecom: [],
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  ...overrides,
})

const subjectFor = (reference: string | null): ObservationRow['subject'] => {
  if (reference === null) return null
  return {
    id: null,
    extension: [],
    display: null,
    reference,
    type: null,
    identifier: null,
  }
}

const blankCode: ObservationRow['code'] = { id: null, extension: [], coding: [], text: null }

const sampleObservation = (
  id: string,
  patientId: string | null,
  overrides: Partial<ObservationRow> = {}
): ObservationRow & { readonly id: string } => {
  let patientReference: string | null = null
  if (patientId !== null) {
    patientReference = `Patient/${patientId}`
  }
  return {
    resourceType: 'Observation',
    id,
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
    subject: subjectFor(patientReference),
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
    ...overrides,
  }
}

export { samplePatient, sampleObservation }
export type { PatientRow, ObservationRow }
