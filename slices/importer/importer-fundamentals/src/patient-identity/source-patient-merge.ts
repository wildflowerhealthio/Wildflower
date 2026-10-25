/**
 * One confirm's merges: each source Patient the reviewer assigned to a person
 * folded into that person, in one walk over the write set.
 *
 * @packageDocumentation
 */

import type { FhirResource, Patient } from '@wildflowerhealthio/fhir-r4/resources'

import * as Person from './person.ts'
import * as SubjectRewrite from './subject-rewrite.ts'

/** One source Patient merging into a person. */
interface Type {
  readonly sourcePatient: Patient.Type
  readonly person: Person.Type
}

/** Whether `resource` is the Patient stored under `id`. */
const isPatientWithId =
  (id: string) =>
  (resource: FhirResource): resource is Patient.Type =>
    resource.resourceType === 'Patient' && resource.id === id

/** What {@link applyTo} folds. */
interface ApplyToArgs {
  /** The write set, the merged source Patients already taken out. */
  readonly resources: readonly FhirResource[]
  /** Each source Patient and the person it merges into, in review order. */
  readonly merges: readonly Type[]
}

/**
 * `resources` with each source Patient of `merges` folded into its person:
 * every reference to the source Patient re-pointed at the person (naming the
 * source identity, as `SubjectRewrite.rewrite` does), and the person, carrying
 * the source's identifiers, written.
 *
 * @returns The write set, each person in place of its copy in `resources` or
 *   appended when it has none
 *
 * @remarks
 * Several source Patients may merge into one person; it is written once,
 * carrying all their identifiers. When `resources` already holds a Patient
 * with the person's `id` (one the import writes as `'new'`), that copy is
 * folded into the person like any source, so the person is not written twice
 * and keeps its own demographics and every identifier it already carried.
 */
const applyTo = ({ resources, merges }: ApplyToArgs): readonly FhirResource[] => {
  const persons = new Map<string, Person.Type>()
  for (const { sourcePatient, person } of merges) {
    const inWriteSet = resources.find(isPatientWithId(person.id))
    const current =
      persons.get(person.id) ??
      (inWriteSet === undefined
        ? person
        : Person.mergeSourceIdentifiers({ person, sourcePatient: inWriteSet }))
    persons.set(person.id, Person.mergeSourceIdentifiers({ person: current, sourcePatient }))
  }
  const placed = resources.map((resource) =>
    resource.resourceType === 'Patient' && resource.id !== null
      ? (persons.get(resource.id) ?? resource)
      : resource
  )
  const appended = [...persons.values()].filter(
    (person) => !resources.some(isPatientWithId(person.id))
  )
  return SubjectRewrite.rewrite({
    resources: [...placed, ...appended],
    moves: merges.map(({ sourcePatient, person }) => ({
      sourcePatient,
      to: `Patient/${person.id}`,
    })),
  }).resources
}

export { applyTo }
export type { ApplyToArgs, Type }
