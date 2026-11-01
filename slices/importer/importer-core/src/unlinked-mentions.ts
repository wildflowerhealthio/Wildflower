import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFile,
  type LinkPlan,
  Mention,
  StagedImport,
  UnlinkedMention,
} from '@wildflowerhealthio/importer-fundamentals'
import { Option, pipe } from 'effect'

import type { FormatKind } from './registry.ts'
import { isSourceFileOf, type ResolvedBatch } from './resolve-mentions.ts'

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
    pipe(
      Option.liftPredicate(resource, (reviewed) => !isSourceFileOf(kind, reviewed)),
      Option.match({
        onNone: () => [],
        onSome: (reviewed) => UnlinkedMention.leftByReferentLinks(plan, reviewKey, reviewed),
      })
    )

/** Whether `unlinked` is of the resource's patient: outside every compartment, or a dangling `subject`. */
const isOfPatient = (unlinked: UnlinkedMention.Type): boolean =>
  UnlinkedMention.match(unlinked, {
    OutsidePatientCompartment: () => true,
    Dangling: ({ mentionPath }) => mentionPath === Mention.SUBJECT_PATH,
  })

/**
 * The keys of `kind`'s rows of `batch` left without a patient as they will
 * be written: each row's edit under `selection`, else its resolved resource
 * (`StagedImport.resolvedResourceOf`), asked what the referent links leave
 * unlinked ({@link leftUnlinkedIn}). The review leaves these out unless the
 * reviewer ticks them, so a link or an edit that gives a row its patient
 * takes it back in.
 *
 * @param batch - The resolved batch
 * @param kind - A format the batch claimed
 * @param selection - The format's selection, whose edits are asked of
 */
const keysWithoutPatientOf = (
  batch: ResolvedBatch,
  kind: FormatKind,
  selection: StagedImport.Selection
): ReadonlySet<string> => {
  const leftUnlinked = leftUnlinkedIn(batch.plan, kind)
  return new Set(
    DecodedFile.resources(batch.formats[kind].decoded)
      .filter((entry) =>
        leftUnlinked(entry.key, StagedImport.resolvedResourceOf(batch.plan, selection, entry)).some(
          isOfPatient
        )
      )
      .map(({ key }) => key)
  )
}

export { isOfPatient, keysWithoutPatientOf, leftUnlinkedIn }
export type { LeftUnlinked }
