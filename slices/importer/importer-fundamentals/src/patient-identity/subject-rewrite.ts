/**
 * Re-pointing the references that name a source Patient at the person it
 * merges into, each still naming the source identity it came through.
 *
 * @packageDocumentation
 */

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  type FhirResource,
  type Patient,
  ResourceReferences,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'

/** A relative literal reference to a Patient, `Patient/<id>`. */
type PatientReference = `Patient/${string}`

/** The relative reference that names `patient`, or `None` when it has no `id`. */
const patientReferenceOf = (patient: {
  readonly id: string | null
}): Option.Option<PatientReference> =>
  patient.id === null ? Option.none() : Option.some<PatientReference>(`Patient/${patient.id}`)

/** One source Patient whose references move: every one naming it is re-pointed at `to`. */
interface Move {
  readonly sourcePatient: Patient.Type
  readonly to: PatientReference
}

/** The resources after {@link rewrite}, and how many references it rewrote. */
interface Result {
  readonly resources: readonly FhirResource[]
  readonly rewrittenCount: number
}

/**
 * Where a reference to one source Patient goes: the person's reference, and
 * the identifier that says which source identity the reference came through.
 */
interface ReferenceTarget {
  readonly to: PatientReference
  readonly sourceIdentifier: IdentifierAndReference.IdentifierType | null
}

/** Each move's {@link ReferenceTarget}, by the source Patient's relative reference. */
const referenceTargetsOf = (moves: readonly Move[]): ReadonlyMap<string, ReferenceTarget> =>
  new Map(
    moves.flatMap(({ sourcePatient, to }) =>
      Option.toArray(
        Option.map(
          patientReferenceOf(sourcePatient),
          (from) => [from, { to, sourceIdentifier: sourcePatient.identifier[0] ?? null }] as const
        )
      )
    )
  )

/** What {@link rewrite} rewrites. */
interface RewriteArgs {
  /** The resources to rewrite. */
  readonly resources: readonly FhirResource[]
  /** Each source Patient and the person's reference its references move to. */
  readonly moves: readonly Move[]
}

/**
 * Every `Reference` in `resources` whose `reference` is exactly a moved
 * source Patient's relative reference, re-pointed at that move's `to` and
 * naming the source identity it came through, in one walk.
 *
 * @returns The rewritten resources and the number of references rewritten
 *
 * @remarks
 * References are found by `fhir-r4`'s `ResourceReferences` walk, so a
 * reference anywhere in a resource moves. A rewritten reference keeps its
 * `display`, and its `identifier` when it carries one. One that carries none
 * gets the source Patient's first identifier (its source key: the adopted
 * source id, or a source's own id such as Shoppers' `PatientId`), so the
 * reference still says which source identity it came through; with no
 * identifier on the source Patient, it stays `null`. Nothing else changes. An
 * absolute or identifier-only reference to the source Patient is left alone
 * ({@link notRewrittenCount} counts them). A resource with no matching
 * reference comes back as itself, and so does every resource when a move's
 * `to` is the source Patient's own reference or the source Patient has no
 * `id`.
 */
const rewrite = ({ resources, moves }: RewriteArgs): Result => {
  const targets = referenceTargetsOf(moves)
  if (targets.size === 0) return { resources, rewrittenCount: 0 }
  let rewrittenCount = 0
  const rewritten = resources.map((resource) =>
    ResourceReferences.map(resource, (reference) => {
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

/** Whether `reference`'s `identifier` is one `patient` carries. */
const carriesIdentifierOf = (
  reference: IdentifierAndReference.ReferenceType,
  patient: Patient.Type
): boolean => {
  const { identifier } = reference
  return (
    identifier !== null &&
    patient.identifier.some((carried) =>
      IdentifierAndReference.identifierEquivalence(carried, identifier)
    )
  )
}

/**
 * Whether `reference` names `sourcePatient` other than by its relative
 * reference: an absolute URL ending in it, or no literal reference but one of
 * its identifiers.
 */
const namesOtherThanRelatively = (
  reference: IdentifierAndReference.ReferenceType,
  sourcePatient: Patient.Type
): boolean =>
  Option.match(patientReferenceOf(sourcePatient), {
    onNone: () => false,
    onSome: (relative) =>
      reference.reference === null
        ? carriesIdentifierOf(reference, sourcePatient)
        : reference.reference !== relative && reference.reference.endsWith(`/${relative}`),
  })

/** What {@link notRewrittenCount} counts over. */
interface NotRewrittenCountArgs {
  /** The resources after the rewrite. */
  readonly resources: readonly FhirResource[]
  /** The source Patients whose references were rewritten. */
  readonly sourcePatients: readonly Patient.Type[]
}

/**
 * How many references in `resources` name one of `sourcePatients` other than
 * by its relative reference — an absolute URL ending in it, or no literal
 * reference but one of its identifiers — and so are left as they are by
 * {@link rewrite}.
 */
const notRewrittenCount = ({ resources, sourcePatients }: NotRewrittenCountArgs): number =>
  sourcePatients.length === 0
    ? 0
    : resources
        .flatMap(ResourceReferences.collect)
        .filter((reference) =>
          sourcePatients.some((sourcePatient) => namesOtherThanRelatively(reference, sourcePatient))
        ).length

export { notRewrittenCount, patientReferenceOf, rewrite }
export type { Move, NotRewrittenCountArgs, PatientReference, Result, RewriteArgs }
