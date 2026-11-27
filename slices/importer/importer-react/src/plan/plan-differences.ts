/**
 * Plan differences: what merging a record of an import plan into each
 * existing record it could merge into would change, worked out once per
 * plan, since `differencesInPlan` reads the whole plan on every call.
 *
 * @packageDocumentation
 */
import { IdentifierUnion, MatchQuery } from '@wildflowerhealthio/fhir-r4/clients'
import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { type FhirResourceWithId, sameStoredResource } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type Difference,
  type DifferencesInPlan,
  differencesInPlan,
  type ExistingRecord,
  type ImportPlan,
  PlannedRecord,
  RecordChoice,
  type RecordKey,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, HashMap, HashSet, Match, Option } from 'effect'

/**
 * An existing record a record could merge into: the stored resource a choice
 * names, how the plan knows of it, and what merging into it would change.
 */
interface Candidate {
  readonly existing: FhirResourceWithId
  readonly knownBy: ExistingRecord.KnownBy
  readonly inPlan: DifferencesInPlan
}

/** The candidates of each record they were worked out for, by its key. */
type Type = HashMap.HashMap<RecordKey.Type, readonly Candidate[]>

/**
 * The candidates of each record of `plan` that needs a decision
 * (`PlannedRecord.needsDecision`): each existing record it could merge into
 * (`PlannedRecord.existingRecordsOf`), with the differences merging into it would
 * make given the plan's choices (`differencesInPlan`).
 *
 * @remarks
 * Computed once per plan value, synchronously: every choice makes a new
 * plan, so every choice computes it again, at a cost of the records that
 * need a decision, times their candidates, times a pass over the whole plan
 * (`differencesInPlan`). Making that cheaper is #1566.
 */
const ofPlan = (plan: ImportPlan.Type): Type =>
  HashMap.fromIterable(
    plan.records.filter(PlannedRecord.needsDecision).map(
      (planned) =>
        [
          planned.record.key,
          PlannedRecord.existingRecordsOf(planned).map(({ resource, knownBy }): Candidate => ({
            existing: resource,
            knownBy,
            inPlan: differencesInPlan(plan, planned, resource),
          })),
        ] as const
    )
  )

/** The candidates of the record under `key`; none when none were worked out for it. */
const candidatesOf = (planDifferences: Type, key: RecordKey.Type): readonly Candidate[] =>
  HashMap.get(planDifferences, key).pipe(Option.getOrElse((): readonly Candidate[] => []))

/** The candidate of the record under `key` that is `existing`; `None` when none is. */
const candidateOf = (
  planDifferences: Type,
  key: RecordKey.Type,
  existing: FhirResourceWithId
): Option.Option<Candidate> =>
  Arr.findFirst(candidatesOf(planDifferences, key), (candidate) =>
    sameStoredResource(candidate.existing, existing)
  )

/** Whether `field` is one of `candidate`'s differences. */
const differsOn = (candidate: Candidate, field: string): boolean =>
  candidate.inPlan.differences.some((difference) => difference.field === field)

/** Every field any of `candidates` differs on, each once, in the order they first come. */
const differingFieldsOf = (candidates: readonly Candidate[]): readonly string[] =>
  Arr.dedupe(candidates.flatMap(({ inPlan }) => inPlan.differences.map(({ field }) => field)))

/**
 * How many of `differences` a merge taking `fieldsTaken` takes. A field
 * taken that is no longer one of `differences` (an earlier merge made it
 * agree) counts for nothing.
 */
const takenAmong = (
  differences: readonly Difference.Type[],
  fieldsTaken: HashSet.HashSet<string>
): number => Arr.filter(differences, ({ field }) => HashSet.has(fieldsTaken, field)).length

/** How much of a candidate's differences a merge into it takes ({@link takenShareOf}). */
interface TakenShare {
  readonly share: 'Every' | 'Some' | 'None'
  readonly taken: number
  readonly differing: number
}

/**
 * How much of `differences` a merge taking `fieldsTaken` takes, decided over
 * `differences` alone ({@link takenAmong}): `Every` one, `Some` of them or
 * `None`, with how many are taken of how many differ.
 */
const takenShareOf = (
  differences: readonly Difference.Type[],
  fieldsTaken: HashSet.HashSet<string>
): TakenShare => {
  const taken = takenAmong(differences, fieldsTaken)
  const differing = differences.length
  const share = Match.value(taken).pipe(
    Match.when(0, (): TakenShare['share'] => 'None'),
    Match.when(differing, (): TakenShare['share'] => 'Every'),
    Match.orElse((): TakenShare['share'] => 'Some')
  )
  return { share, taken, differing }
}

/**
 * The fields `choice` takes into `existing`, when it merges into it; `None`
 * for any other choice, or none.
 */
const fieldsTakenInto = (
  choice: Option.Option<RecordChoice.Type>,
  existing: FhirResourceWithId
): Option.Option<HashSet.HashSet<string>> =>
  choice.pipe(
    Option.filter(RecordChoice.is('MergeIntoExistingRecord')),
    Option.filter((merge) => sameStoredResource(merge.existing, existing)),
    Option.map(({ fieldsTaken }) => fieldsTaken)
  )

/**
 * The qualified identifiers merging into `candidate` adds to it: those the
 * incoming record carries that the kept record lacks
 * (`IdentifierUnion.missingFrom`).
 */
const identifiersAddedBy = ({
  inPlan,
}: Candidate): readonly IdentifierAndReference.QualifiedIdentifierType[] =>
  IdentifierUnion.missingFrom(MatchQuery.qualifiedIdentifiersOf(inPlan.kept), inPlan.incoming)

/**
 * Those of `statedIdentityFields`, the identity fields the imported record
 * states, that none of `candidates` differs on; none when there are no
 * candidates to agree with.
 */
const sameIdentityFieldsOf = (
  statedIdentityFields: readonly string[],
  candidates: readonly Candidate[]
): readonly string[] => {
  if (candidates.length === 0) return []
  const differing = differingFieldsOf(candidates)
  return statedIdentityFields.filter((field) => !differing.includes(field))
}

export {
  candidateOf,
  candidatesOf,
  differingFieldsOf,
  differsOn,
  fieldsTakenInto,
  identifiersAddedBy,
  ofPlan,
  sameIdentityFieldsOf,
  takenAmong,
  takenShareOf,
}
export type { Candidate, TakenShare, Type }
