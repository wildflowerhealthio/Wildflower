/**
 * What the patient-identity tests share: decoders, generated Patients and
 * resources, and a wire-side oracle for the references a resource carries.
 *
 * @packageDocumentation
 */

import {
  FhirResourceSchema,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
  type FhirResource,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Arbitrary, FastCheck as fc, Schema } from 'effect'

import * as Person from './person.ts'

const decodePatient: (input: unknown) => Patient.Type = Schema.decodeUnknownSync(Patient.Schema)
const decodeDispense = Schema.decodeUnknownSync(MedicationDispense.Schema)
const encodeResource = Schema.encodeSync(FhirResourceSchema)
const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

/** A resource as its wire JSON text: what "byte-identical" compares. */
const wireOf = (resource: FhirResource): string => JSON.stringify(encodeResource(resource))

/** A person: a stored Patient, so one with an `id`. */
const person = (id: string, identifier: readonly object[] = []): Person.Type => ({
  ...decodePatient({ resourceType: 'Patient', id, identifier }),
  id,
})

/** Generated Patients with no `contained` (raw JSON the walk is not about). */
const patientArbitrary = Arbitrary.make(Patient.Schema).map((patient): Patient.Type => ({
  ...patient,
  contained: [],
}))

/** A Patient whose identifiers are a set by `system` + `value`, as a stored person's are. */
const personArbitrary = patientArbitrary.map((patient): Person.Type => ({
  ...Person.mergeSourceIdentifiers({
    person: { ...patient, identifier: [] },
    sourcePatient: patient,
  }),
  id: patient.id ?? 'person',
}))

/** The `system|value` keys of a Patient's identifiers. */
const identifierKeys = (patient: Patient.Type): readonly string[] =>
  patient.identifier.map((identifier) => `${identifier.system?.href ?? ''}|${identifier.value}`)

/** Generated resources of the types that carry references, with no `contained`. */
const resourceArbitrary: fc.Arbitrary<FhirResource> = fc.oneof(
  patientArbitrary,
  Arbitrary.make(Observation.Schema).map((observation): FhirResource => ({
    ...observation,
    contained: [],
  })),
  Arbitrary.make(MedicationRequest.Schema).map((request): FhirResource => ({
    ...request,
    contained: [],
  })),
  Arbitrary.make(MedicationDispense.Schema).map((dispense): FhirResource => ({
    ...dispense,
    contained: [],
  }))
)

/**
 * Every `reference` string the wire form of `resource` carries on a
 * Reference-shaped object — an oracle independent of the decoded-side walk.
 */
const wireReferences = (resource: FhirResource): readonly string[] => {
  const found: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const element of value) visit(element)
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, field] of Object.entries(value)) {
        if (key === 'reference' && typeof field === 'string') found.push(field)
        else visit(field)
      }
    }
  }
  visit(encodeResource(resource))
  return found
}

export {
  decodeDispense,
  decodePatient,
  decodeResource,
  encodeResource,
  identifierKeys,
  person,
  personArbitrary,
  patientArbitrary,
  resourceArbitrary,
  wireOf,
  wireReferences,
}
