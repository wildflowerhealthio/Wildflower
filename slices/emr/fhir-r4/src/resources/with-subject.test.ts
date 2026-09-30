import { Arbitrary, FastCheck as fc, type Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { ReferenceType } from '../data-types/complex/identifier-and-reference.ts'
import {
  Binary,
  CarePlan,
  DiagnosticReport,
  DocumentReference,
  type FhirResource,
  Goal,
  ImagingStudy,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
  Practitioner,
  ServiceRequest,
} from './index.ts'
import { SUBJECT_RESOURCE_TYPES, withSubject } from './with-subject.ts'

/** One sample of `schema`, the same every run. */
const sample = <A, I>(schema: Schema.Schema<A, I>, seed: number): A => {
  const [value] = fc.sample(Arbitrary.make(schema), { numRuns: 1, seed })
  if (value === undefined) throw new Error('unreachable: one sample requested')
  return value
}

/** One resource of each type in the closed union; `satisfies` keeps it complete. */
const SAMPLES = {
  Binary: sample(Binary.Schema, 1),
  DiagnosticReport: sample(DiagnosticReport.Schema, 2),
  DocumentReference: sample(DocumentReference.Schema, 3),
  ImagingStudy: sample(ImagingStudy.Schema, 4),
  MedicationDispense: sample(MedicationDispense.Schema, 5),
  MedicationRequest: sample(MedicationRequest.Schema, 6),
  Observation: sample(Observation.Schema, 7),
  Patient: sample(Patient.Schema, 8),
  Practitioner: sample(Practitioner.Schema, 9),
  ServiceRequest: sample(ServiceRequest.Schema, 10),
  CarePlan: sample(CarePlan.Schema, 11),
  Goal: sample(Goal.Schema, 12),
} satisfies Record<FhirResource['resourceType'], FhirResource>

const resources: readonly FhirResource[] = Object.values(SAMPLES)

const subject: ReferenceType = {
  id: null,
  extension: [],
  display: null,
  identifier: null,
  reference: 'Patient/elsewhere',
  type: null,
}

describe('withSubject', () => {
  // Derived from the schemas, so a resource type added with a `subject` and
  // left out of SUBJECT_RESOURCE_TYPES fails here.
  test('covers exactly the resource types whose schema has a subject', () => {
    expect(
      resources
        .filter((resource) => 'subject' in resource)
        .map((resource) => resource.resourceType)
        .toSorted()
    ).toEqual([...SUBJECT_RESOURCE_TYPES].toSorted())
  })

  for (const resource of resources) {
    test(`${resource.resourceType}: changes the subject and nothing else`, () => {
      const filed = withSubject(subject)(resource)
      if ('subject' in resource) {
        expect(filed).toEqual({ ...resource, subject })
      } else {
        expect(filed).toBe(resource)
      }
    })
  }
})
