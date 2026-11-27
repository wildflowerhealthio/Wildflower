/**
 * An existing record: a stored record an imported record could merge into,
 * and how the plan comes to know of it.
 *
 * @packageDocumentation
 */
import type { MatchGrade, ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Data } from 'effect'

/** How the plan comes to know of an existing record. */
type KnownBy = Data.TaggedEnum<{
  /** A search matched it: the matcher's grade and what it was found by. */
  MatchedBySearch: {
    readonly grade: MatchGrade.Type
    readonly evidence: ResourceMatch.Evidence
  }
  /** It is stored under the id the import stage derived for the record; no search found it. */
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  StoredUnderDerivedId: Record<never, never>
  /** The reviewer chose it; nothing the plan read from the store offered it. */
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  ChosenByReviewer: Record<never, never>
}>

const { MatchedBySearch, StoredUnderDerivedId, ChosenByReviewer } = Data.taggedEnum<KnownBy>()

/** An existing record an imported record could merge into: its stored resource, and how the plan knows of it. */
interface Type {
  readonly resource: FhirResourceWithId
  readonly knownBy: KnownBy
}

export { ChosenByReviewer, MatchedBySearch, StoredUnderDerivedId }
export type { KnownBy, Type }
