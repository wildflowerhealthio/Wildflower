/**
 * One Patient per human: the pure steps that fold a source's Patient into the
 * person it belongs to, and point everything that named the source Patient at
 * that person instead.
 *
 * @remarks
 * Every source an import reads makes its own Patient (adoption keys it under
 * the source's namespace — see `fhir-r4`'s Source Identity Explanation), so one
 * human with a pharmacy account and a hospital record arrives as two. A
 * **source Patient is never a person.** A person is a Patient the user owns,
 * and it accumulates the identifiers of every source Patient merged into it:
 * {@link mergeIntoPatient} adds them and nothing else, and
 * {@link rewriteSubjects} re-points the references, each naming the source
 * identity it came through. A merged source Patient is not written.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { FhirResource, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Option, Schema } from 'effect'

type Reference = IdentifierAndReference.ReferenceType
type Identifier = IdentifierAndReference.IdentifierType

/** A Patient the user owns: the person source Patients merge into. Always stored, so it has an `id`. */
type Person = Omit<Patient.Type, 'id'> & { readonly id: string }

/**
 * Where a source Patient goes at confirm: `'new'` writes it as it is, so it
 * becomes the person; `{ person }` merges it into that existing person.
 */
type Target = 'new' | { readonly person: Person }

/** A relative literal reference to a Patient, `Patient/<id>`. */
type PatientReference = `Patient/${string}`

/** The relative reference that names `patient`, or `None` when it has no `id`. */
const patientReferenceOf = (patient: {
  readonly id: string | null
}): Option.Option<PatientReference> =>
  patient.id === null ? Option.none() : Option.some<PatientReference>(`Patient/${patient.id}`)

/** One source Patient merging into a person: the pair {@link mergeSourcePatients} folds. */
interface SourceMerge {
  readonly sourcePatient: Patient.Type
  readonly person: Person
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Whether two identifiers name the same thing: the same `system` and the same `value`. */
const isSameIdentifier = (left: Identifier, right: Identifier): boolean =>
  (left.system?.href ?? null) === (right.system?.href ?? null) && left.value === right.value

/**
 * `target` with every identifier of `source` it does not already carry
 * appended, matched on `system` + `value`.
 *
 * @param target - The person (or any Patient) the source folds into
 * @param source - The source Patient whose identifiers are kept
 * @returns `target` with nothing but `identifier` changed
 *
 * @remarks
 * The target's demographics are the truth and a source's spelling of them is
 * not, so nothing else of `source` is read. A demographic conflict (a
 * different `birthDate`) is the reviewer's to see, never resolved here.
 * Idempotent: merging the same source twice adds nothing the second time.
 */
const mergeIntoPatient = <TPatient extends Patient.Type>(
  target: TPatient,
  source: Patient.Type
): TPatient => {
  const identifier = source.identifier.reduce<readonly Identifier[]>(
    (kept, candidate) =>
      kept.some((present) => isSameIdentifier(present, candidate)) ? kept : [...kept, candidate],
    target.identifier
  )
  return identifier.length === target.identifier.length ? target : { ...target, identifier }
}

// ---------------------------------------------------------------------------
// The reference walk
// ---------------------------------------------------------------------------

/** Whether `value` is a record the decode built — not a `URL` or any other class instance. */
const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const isReferenceSchema = Schema.is(Schema.typeSchema(IdentifierAndReference.ReferenceSchema))

/**
 * Whether a decoded record is a `Reference`, as `fhir-r4`'s schema decides.
 * The key test only spares the schema check on the records that cannot be one.
 */
const isReference = (value: unknown): value is Reference =>
  isPlainRecord(value) && 'reference' in value && isReferenceSchema(value)

/**
 * `value` with `rewrite` applied to every decoded `Reference` in it, found by
 * `fhir-r4`'s own `Reference` schema rather than a list of field names.
 * Records and arrays nothing changed in come back as themselves.
 */
const mapReferencesIn = (value: unknown, rewrite: (reference: Reference) => Reference): unknown => {
  if (Array.isArray(value)) {
    const elements: readonly unknown[] = value
    const mapped = elements.map((element) => mapReferencesIn(element, rewrite))
    return mapped.every((element, index) => element === elements[index]) ? value : mapped
  }
  if (!isPlainRecord(value)) return value
  const visited = isReference(value) ? rewrite(value) : value
  const fields = Object.entries(visited)
  const mapped = fields.map(([key, field]) => [key, mapReferencesIn(field, rewrite)] as const)
  const unchanged =
    visited === value && mapped.every(([, field], index) => field === fields[index]?.[1])
  return unchanged ? value : Object.fromEntries(mapped)
}

/**
 * `resource` with `rewrite` applied to every `Reference` it carries, at any
 * depth.
 *
 * @remarks
 * The walk rebuilds only the records and arrays something changed in, and
 * replaces a `Reference` only with what `rewrite` returns for it, so the
 * result has `resource`'s own shape. The type system cannot follow a walk over
 * every field, hence the one assertion; the property tests pin the shape.
 */
const mapReferences = <TResource extends FhirResource>(
  resource: TResource,
  rewrite: (reference: Reference) => Reference
): TResource =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the walk keeps the shape; see @remarks
  mapReferencesIn(resource, rewrite) as TResource

/** Every `Reference` `resource` carries, at any depth, in walk order. */
const referencesIn = (resource: FhirResource): readonly Reference[] => {
  const found: Reference[] = []
  mapReferencesIn(resource, (reference) => {
    found.push(reference)
    return reference
  })
  return found
}

/** The resources after {@link rewriteSubjects}, and how many references it rewrote. */
interface SubjectRewrite {
  readonly resources: readonly FhirResource[]
  readonly rewrittenCount: number
}

/**
 * Where a reference to one source Patient goes: the person's reference, and
 * the identifier that says which source identity the reference came through.
 */
interface ReferenceTarget {
  readonly to: PatientReference
  readonly sourceIdentifier: Identifier | null
}

/** The {@link ReferenceTarget} for references to `sourcePatient`, re-pointed at `to`. */
const referenceTargetOf = (sourcePatient: Patient.Type, to: PatientReference): ReferenceTarget => ({
  to,
  sourceIdentifier: sourcePatient.identifier[0] ?? null,
})

/**
 * Every `Reference` whose `reference` is a key of `targets`, re-pointed at its
 * target and given the target's source identifier when it carries none, in
 * one walk.
 */
const rewriteReferences = (
  resources: readonly FhirResource[],
  targets: ReadonlyMap<string, ReferenceTarget>
): SubjectRewrite => {
  if (targets.size === 0) return { resources, rewrittenCount: 0 }
  let rewrittenCount = 0
  const rewritten = resources.map((resource) =>
    mapReferences(resource, (reference) => {
      const target = reference.reference === null ? undefined : targets.get(reference.reference)
      if (target === undefined || target.to === reference.reference) return reference
      rewrittenCount += 1
      return {
        ...reference,
        reference: target.to,
        identifier: reference.identifier ?? target.sourceIdentifier,
      }
    })
  )
  return { resources: rewritten, rewrittenCount }
}

/**
 * Every `Reference` in `resources` whose `reference` is exactly
 * `sourcePatient`'s relative reference, re-pointed at `to` and naming the
 * source identity it came through.
 *
 * @param resources - The resources to rewrite
 * @param sourcePatient - The source Patient the references name
 * @param to - The person's relative reference
 * @returns The rewritten resources and the number of references rewritten
 *
 * @remarks
 * A rewritten reference keeps its `display`, and its `identifier` when it
 * carries one. One that carries none gets the source Patient's first
 * identifier (its source key: the adopted source id, or a source's own id
 * such as Shoppers' `PatientId`), so the reference still says which source
 * identity it came through; with no identifier on the source Patient, it stays
 * `null`. Nothing else changes. An absolute or identifier-only reference to
 * the source Patient is left alone ({@link referencesNotRewrittenCount} counts
 * them). A resource with no matching reference comes back as itself, and so
 * does every resource when `to` is the source Patient's own reference or the
 * source Patient has no `id`.
 */
const rewriteSubjects = (
  resources: readonly FhirResource[],
  sourcePatient: Patient.Type,
  to: PatientReference
): SubjectRewrite =>
  rewriteReferences(
    resources,
    new Map(
      Option.toArray(
        Option.map(
          patientReferenceOf(sourcePatient),
          (from) => [from, referenceTargetOf(sourcePatient, to)] as const
        )
      )
    )
  )

/** Whether `reference`'s `identifier` is one `patient` carries. */
const carriesIdentifierOf = (reference: Reference, patient: Patient.Type): boolean => {
  const { identifier } = reference
  return (
    identifier !== null &&
    patient.identifier.some((carried) => isSameIdentifier(carried, identifier))
  )
}

/**
 * Whether `reference` names `sourcePatient` other than by its relative
 * reference: an absolute URL ending in it, or no literal reference but one of
 * its identifiers.
 */
const namesOtherThanRelatively = (reference: Reference, sourcePatient: Patient.Type): boolean =>
  Option.match(patientReferenceOf(sourcePatient), {
    onNone: () => false,
    onSome: (relative) =>
      reference.reference === null
        ? carriesIdentifierOf(reference, sourcePatient)
        : reference.reference !== relative && reference.reference.endsWith(`/${relative}`),
  })

/**
 * How many references in `resources` name one of `sourcePatients` other than
 * by its relative reference — an absolute URL ending in it, or no literal
 * reference but one of its identifiers — and so are left as they are by
 * {@link rewriteSubjects}.
 */
const referencesNotRewrittenCount = (
  resources: readonly FhirResource[],
  sourcePatients: readonly Patient.Type[]
): number =>
  sourcePatients.length === 0
    ? 0
    : resources
        .flatMap(referencesIn)
        .filter((reference) =>
          sourcePatients.some((sourcePatient) => namesOtherThanRelatively(reference, sourcePatient))
        ).length

// ---------------------------------------------------------------------------
// Merging source Patients into persons
// ---------------------------------------------------------------------------

/**
 * `resources` with each source Patient of `merges` folded into its person:
 * every reference to the source Patient re-pointed at the person (naming the
 * source identity, as {@link rewriteSubjects} does), and the person, carrying
 * the source's identifiers, written.
 *
 * @param resources - The write set, the merged source Patients already taken out
 * @param merges - Each source Patient and the person it merges into, in review order
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
const mergeSourcePatients = (
  resources: readonly FhirResource[],
  merges: readonly SourceMerge[]
): readonly FhirResource[] => {
  const persons = new Map<string, Person>()
  for (const { sourcePatient, person } of merges) {
    const inWriteSet = resources.find(
      (resource): resource is Patient.Type =>
        resource.resourceType === 'Patient' && resource.id === person.id
    )
    const current =
      persons.get(person.id) ??
      (inWriteSet === undefined ? person : mergeIntoPatient(person, inWriteSet))
    persons.set(person.id, mergeIntoPatient(current, sourcePatient))
  }
  const placed = resources.map((resource) =>
    resource.resourceType === 'Patient' && resource.id !== null
      ? (persons.get(resource.id) ?? resource)
      : resource
  )
  const appended = [...persons.values()].filter(
    (person) =>
      !resources.some(
        (resource) => resource.resourceType === 'Patient' && resource.id === person.id
      )
  )
  const targets = new Map(
    merges.flatMap(({ sourcePatient, person }) =>
      Option.toArray(
        Option.map(
          patientReferenceOf(sourcePatient),
          (from) => [from, referenceTargetOf(sourcePatient, `Patient/${person.id}`)] as const
        )
      )
    )
  )
  return rewriteReferences([...placed, ...appended], targets).resources
}

/** An identifier with both halves of a `system|value` search token. */
type SearchedIdentifier = Identifier & { readonly system: URL; readonly value: string }

const isSearchable = (identifier: Identifier): identifier is SearchedIdentifier =>
  identifier.system !== null && identifier.value !== null

/**
 * The identifiers a search for `sourcePatient`'s person tries, in order: each
 * one with both a `system` and a `value`.
 *
 * @remarks
 * A bare value with no system could match any system's identifier, so it is
 * not searched.
 */
const searchedIdentifiers = (sourcePatient: Patient.Type): readonly SearchedIdentifier[] =>
  sourcePatient.identifier.filter(isSearchable)

export {
  mergeIntoPatient,
  mergeSourcePatients,
  patientReferenceOf,
  referencesIn,
  referencesNotRewrittenCount,
  rewriteSubjects,
  searchedIdentifiers,
}
export type { PatientReference, Person, SearchedIdentifier, SourceMerge, SubjectRewrite, Target }
