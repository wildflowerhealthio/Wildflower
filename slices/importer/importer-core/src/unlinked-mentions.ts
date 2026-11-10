import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type LinkPlan,
  Mention,
  StagedImport,
  UnlinkedMention,
} from '@wildflowerhealthio/importer-fundamentals'

import type { FormatKind } from './registry.ts'
import { isSourceFileOf } from './resolve-mentions.ts'
import * as ReviewGroup from './review-group.ts'

/**
 * What the referent links leave unlinked in a format's rows, and the rows
 * that leaves without a patient: the rule the review's default exclusion
 * reads, kept here so the screen and a headless import read the same one.
 *
 * @packageDocumentation
 */

/** What the referent links leave unlinked in one resource of a format, reviewed under a key. */
type LeftUnlinked = (
  reviewKey: string,
  resource: FhirResourceWithId
) => readonly UnlinkedMention.Type[]

/**
 * What the referent links of `plan` leave unlinked in a resource of `kind`
 * (`UnlinkedMention.leftByReferentLinks`): nothing for the format's own
 * source file (`isSourceFileOf`), which the review never asks a patient for.
 */
const leftUnlinkedIn =
  (plan: LinkPlan.Type, kind: FormatKind): LeftUnlinked =>
  (reviewKey, resource) =>
    isSourceFileOf(kind, resource)
      ? []
      : UnlinkedMention.leftByReferentLinks(plan, reviewKey, resource)

/** Whether `unlinked` is of the resource's patient: outside every compartment, or a dangling `subject`. */
const isOfPatient = (unlinked: UnlinkedMention.Type): boolean =>
  UnlinkedMention.match(unlinked, {
    OutsidePatientCompartment: () => true,
    Dangling: ({ mentionPath }) => mentionPath === Mention.SUBJECT_PATH,
  })

/**
 * The keys of the rows of `group`, `kind`'s resolved group, left without a
 * patient as they will be written: each row's edit under `selection`, else
 * its resolved resource (`StagedImport.resolvedResourceOf`), asked what the
 * referent links of `plan` leave unlinked ({@link leftUnlinkedIn}). The
 * review leaves these out unless the reviewer ticks them, so a link or an
 * edit that gives a row its patient takes it back in.
 *
 * @param plan - The plan the batch was resolved on
 * @param kind - The format `group` is of, whose own source files are never asked
 * @param group - The format's resolved group
 * @param selection - The format's selection, whose edits are asked of
 */
const keysWithoutPatientOf = (
  plan: LinkPlan.Type,
  kind: FormatKind,
  group: ReviewGroup.Type,
  selection: StagedImport.Selection
): ReadonlySet<string> => {
  const leftUnlinked = leftUnlinkedIn(plan, kind)
  return new Set(
    ReviewGroup.rows(group)
      .filter((row) =>
        leftUnlinked(row.reviewKey, StagedImport.resolvedResourceOf(plan, selection, row)).some(
          isOfPatient
        )
      )
      .map(({ reviewKey }) => reviewKey)
  )
}

export { isOfPatient, keysWithoutPatientOf, leftUnlinkedIn }
export type { LeftUnlinked }
