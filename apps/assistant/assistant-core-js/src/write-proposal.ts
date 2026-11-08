import type { FieldDiff, ResourceWrite } from '@wildflowerhealthio/fhir-r4/clients'
import { Match, type Option } from 'effect'

import { countOf } from './internal/count-of.ts'

/**
 * A write the agent proposed, as the person sees it before deciding: the
 * record a `create_record` call would create, or the change an
 * `update_record` call would make, field by field against the record as it
 * is now; and the person's decision on it.
 *
 * @remarks
 * A namespace module: `WriteProposal.Type`, `WriteProposal.Decision`,
 * `WriteProposal.FieldChange`, `WriteProposal.summaryOf`,
 * `WriteProposal.fieldChangeOf`. `Tools.propose` builds one from a write call;
 * `Tools.carryOut` runs it once decided. A proposal is never kept: the chat
 * keeps the call and its result.
 *
 * @packageDocumentation
 */

/** A proposed write, for the call `callId` names. */
type Type =
  /** Create `resource`, as it will be sent (in a chat about one patient, its reference to them set). */
  | {
      readonly kind: 'create'
      readonly callId: string
      readonly resource: ResourceWrite.ResourceJson
    }
  /**
   * Update the record `resource` names to `resource`, against the version
   * `versionId`, which is the record as it is now: `fields` is how
   * `resource` differs from it, server-managed `meta` left out.
   */
  | {
      readonly kind: 'update'
      readonly callId: string
      readonly resource: ResourceWrite.ResourceJson & { readonly id: string }
      readonly versionId: string
      readonly fields: readonly FieldDiff[]
    }

/** The person's decision on a proposal: approved, or declined with their reason if they gave one. */
type Decision =
  | { readonly kind: 'approved' }
  | { readonly kind: 'declined'; readonly reason: Option.Option<string> }

/** What an update does to one field: adds it, changes it, or removes it. */
type FieldChange = 'added' | 'changed' | 'removed'

/** What `field`, a leaf of an update's diff, does: added where the record has none, removed where the change has none. */
const fieldChangeOf = ({ server, incoming }: FieldDiff): FieldChange => {
  if (server._tag === 'absent') return 'added'
  if (incoming._tag === 'absent') return 'removed'
  return 'changed'
}

/** One line saying what `proposal` would do: "Create Observation", "Update MedicationRequest/123, 2 fields". */
const summaryOf = (proposal: Type): string =>
  Match.value(proposal).pipe(
    Match.when({ kind: 'create' }, ({ resource }) => `Create ${resource.resourceType}`),
    Match.when(
      { kind: 'update' },
      ({ resource, fields }) =>
        `Update ${resource.resourceType}/${resource.id}, ${countOf(fields.length, 'field')}`
    ),
    Match.exhaustive
  )

export { fieldChangeOf, summaryOf }
export type { Decision, FieldChange, Type }
