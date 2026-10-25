/**
 * A person: a Patient the user owns, which the source Patients of one human
 * merge into, accumulating their identifiers.
 *
 * @remarks
 * Every source an import reads makes its own Patient (adoption keys it under
 * the source's namespace — see `fhir-r4`'s Source Identity Explanation), so one
 * human with a pharmacy account and a hospital record arrives as two. A
 * **source Patient is never a person.** A person is a Patient the user owns,
 * and it accumulates the identifiers of every source Patient merged into it
 * ({@link mergeSourceIdentifiers}); `SourcePatientMerge` re-points the
 * references. A merged source Patient is not written.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { Patient } from '@wildflowerhealthio/fhir-r4/resources'

/** A Patient the user owns: the person source Patients merge into. Always stored, so it has an `id`. */
type Type = Omit<Patient.Type, 'id'> & { readonly id: string }

/**
 * Where a source Patient goes at confirm: `'new'` writes it as it is, so it
 * becomes the person; `{ person }` merges it into that existing person.
 */
type Target = 'new' | { readonly person: Type }

/** What {@link mergeSourceIdentifiers} folds: a source Patient's identifiers into a person. */
interface MergeSourceIdentifiersArgs<TPatient extends Patient.Type> {
  /** The person (or any Patient) the source Patient folds into. */
  readonly person: TPatient
  /** The source Patient whose identifiers are kept. */
  readonly sourcePatient: Patient.Type
}

/**
 * `person` with every identifier of `sourcePatient` it does not already
 * carry appended, matched on `system` + `value`.
 *
 * @returns `person` with nothing but `identifier` changed
 *
 * @remarks
 * The person's demographics are the truth and a source's spelling of them is
 * not, so nothing else of `sourcePatient` is read. A demographic conflict (a
 * different `birthDate`) is the reviewer's to see, never resolved here.
 * Idempotent: merging the same source Patient twice adds nothing the second
 * time.
 */
const mergeSourceIdentifiers = <TPatient extends Patient.Type>({
  person,
  sourcePatient,
}: MergeSourceIdentifiersArgs<TPatient>): TPatient => {
  const identifier = sourcePatient.identifier.reduce<
    readonly IdentifierAndReference.IdentifierType[]
  >(
    (kept, candidate) =>
      kept.some((present) => IdentifierAndReference.identifierEquivalence(present, candidate))
        ? kept
        : [...kept, candidate],
    person.identifier
  )
  return identifier.length === person.identifier.length ? person : { ...person, identifier }
}

export { mergeSourceIdentifiers }
export type { MergeSourceIdentifiersArgs, Target, Type }
