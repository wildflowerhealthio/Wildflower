/**
 * How the review reads what the referent links leave unlinked in a format:
 * asked of each row as reviewed (its edit override, else the resource as
 * decoded), which resources need a patient and which a provider, and why
 * each is listed, in one phrase.
 *
 * @packageDocumentation
 */

import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { type FormatKind, isSourceFileOf } from '@wildflowerhealthio/importer-core'
import {
  DecodedFile,
  type LinkPlan,
  Mention,
  StagedImport,
  UnlinkedMention,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array, Option, pipe } from 'effect'

import {
  NAMES_NO_PATIENT,
  NAMES_UNLINKED_ACCOUNT,
  NAMES_UNLINKED_PROVIDER,
  POINTS_OUTSIDE_IMPORT,
} from './preview-text.ts'

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

/** The resource reviewed under `key`: its edit override in `selection`, else `asDecoded`. */
const reviewedResource = (
  selection: StagedImport.Selection,
  key: string,
  asDecoded: FhirResourceWithId
): FhirResourceWithId =>
  Option.getOrElse(StagedImport.editedResource(selection, key), () => asDecoded)

/**
 * What the referent links leave unlinked in every row of `decodedFile` (the
 * format's file as decoded), each as reviewed under `selection`, in review
 * order.
 */
const unlinkedInRows = (
  decodedFile: DecodedFile.DecodedFile,
  selection: StagedImport.Selection,
  leftUnlinked: LeftUnlinked
): readonly UnlinkedMention.Type[] =>
  DecodedFile.resources(decodedFile).flatMap(({ key, resource }) =>
    leftUnlinked(key, reviewedResource(selection, key, resource))
  )

/** Whether `unlinked` is of the resource's patient: outside every compartment, or a dangling `subject`. */
const isOfPatient = (unlinked: UnlinkedMention.Type): boolean =>
  UnlinkedMention.match(unlinked, {
    OutsidePatientCompartment: () => true,
    Dangling: ({ mentionPath }) => mentionPath === Mention.SUBJECT_PATH,
  })

/** Whether `unlinked` is the mention at `mentionPath` of the resource reviewed under `reviewKey`. */
const isAt = (unlinked: UnlinkedMention.Type, reviewKey: string, mentionPath: string): boolean =>
  unlinked.mentioningResourceKey === reviewKey &&
  UnlinkedMention.match(unlinked, {
    OutsidePatientCompartment: () => mentionPath === Mention.SUBJECT_PATH,
    Dangling: (dangling) => dangling.mentionPath === mentionPath,
  })

/** The review keys of the resources whose patient `unlinked` leaves unlinked. */
const keysNeedingPatient = (unlinked: readonly UnlinkedMention.Type[]): ReadonlySet<string> =>
  new Set(unlinked.filter(isOfPatient).map((one) => one.mentioningResourceKey))

/** The resources listed under Needs a patient and under Needs a provider. */
interface Groups {
  readonly needingPatient: readonly DecodedFile.Resource[]
  readonly needingProvider: readonly DecodedFile.Resource[]
}

/**
 * Which resources of `decodedFile` `unlinked` lists where: under Needs a
 * patient when their patient is unlinked, else under Needs a provider.
 */
const groupsOf = (
  decodedFile: DecodedFile.DecodedFile,
  unlinked: readonly UnlinkedMention.Type[]
): Groups => {
  const patientKeys = keysNeedingPatient(unlinked)
  const providerKeys = new Set(
    unlinked.filter((one) => !isOfPatient(one)).map((one) => one.mentioningResourceKey)
  )
  const resources = DecodedFile.resources(decodedFile)
  return {
    needingPatient: resources.filter(({ key }) => patientKeys.has(key)),
    needingProvider: resources.filter(({ key }) => providerKeys.has(key) && !patientKeys.has(key)),
  }
}

/** Why `unlinked` is listed, in one phrase. */
const reasonOf = (unlinked: UnlinkedMention.Type): string =>
  UnlinkedMention.match(unlinked, {
    // A subject with a literal that names no record of the device is an absolute URL.
    OutsidePatientCompartment: ({ subjectAsReviewed }) =>
      Option.exists(subjectAsReviewed, ({ reference }) => reference !== null)
        ? POINTS_OUTSIDE_IMPORT
        : NAMES_NO_PATIENT,
    Dangling: ({ mentionPath }) =>
      mentionPath === Mention.SUBJECT_PATH ? NAMES_UNLINKED_ACCOUNT : NAMES_UNLINKED_PROVIDER,
  })

/** Why a resource is listed, given what is left unlinked in it as it reads now: each reason once, joined. */
const reasonsLine = (unlinkedInResource: readonly UnlinkedMention.Type[]): string =>
  pipe(unlinkedInResource, Array.map(reasonOf), Array.dedupe).join(' · ')

export {
  groupsOf,
  isAt,
  isOfPatient,
  keysNeedingPatient,
  leftUnlinkedIn,
  reasonsLine,
  reviewedResource,
  unlinkedInRows,
}
export type { Groups, LeftUnlinked }
