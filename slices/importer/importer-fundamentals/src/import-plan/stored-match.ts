/**
 * A stored match: what the store holds of an import's records and of the
 * logical references that name no record of the import, found before the
 * plan is built.
 *
 * @packageDocumentation
 */
import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResourceWithId, LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { HashMap } from 'effect'

import type * as RecordKey from './record-key.ts'

/**
 * Each record's stored candidates, the stored record under the id a record's
 * key derives, and each unresolved logical reference's stored candidates.
 *
 * @remarks
 * A record or a reference with no entry has no candidate. A record has an
 * entry in `storedUnderDerivedIdByRecord` only when it has a derived id, no
 * candidate was found for it by identifier, and the store holds a resource
 * under that id.
 */
interface Type {
  /** Each record's candidates, best grade first, by its key. */
  readonly candidatesByRecord: HashMap.HashMap<RecordKey.Type, readonly ResourceMatch.Candidate[]>
  readonly storedUnderDerivedIdByRecord: HashMap.HashMap<RecordKey.Type, FhirResourceWithId>
  /** Each unresolved logical reference's candidates, best grade first, by `LogicalReference.key`. */
  readonly candidatesByUnresolvedReference: HashMap.HashMap<
    LogicalReference.Key,
    readonly ResourceMatch.Candidate[]
  >
}

/** Nothing stored matches. */
const empty: Type = {
  candidatesByRecord: HashMap.empty(),
  storedUnderDerivedIdByRecord: HashMap.empty(),
  candidatesByUnresolvedReference: HashMap.empty(),
}

export { empty }
export type { Type }
