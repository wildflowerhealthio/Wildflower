/**
 * How the review reads a format's unlinked mentions: which resources need a
 * patient and which a provider, and why each is listed, in one phrase.
 *
 * @packageDocumentation
 */

import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { DecodedFile, Mention, UnlinkedMention } from '@wildflowerhealthio/importer-fundamentals'
import { Array } from 'effect'

import {
  NAMES_NO_PATIENT,
  NAMES_UNLINKED_ACCOUNT,
  NAMES_UNLINKED_PROVIDER,
  POINTS_OUTSIDE_IMPORT,
} from './preview-text.ts'

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

/** The unlinked mentions of `resource` alone, as reviewed: one resource read as a file. */
const unlinkedIn = (key: string, resource: FhirResourceWithId): readonly UnlinkedMention.Type[] =>
  UnlinkedMention.collect({
    sections: [{ title: '', resources: [{ key, title: '', resource }] }],
    notes: [],
  })

/** Why `unlinked`, of `resource`, is listed, in one phrase. */
const reasonOf = (unlinked: UnlinkedMention.Type, resource: FhirResourceWithId): string =>
  UnlinkedMention.match(unlinked, {
    // A subject with a literal that names no record of the device is an absolute URL.
    OutsidePatientCompartment: () =>
      'subject' in resource && resource.subject?.reference != null
        ? POINTS_OUTSIDE_IMPORT
        : NAMES_NO_PATIENT,
    Dangling: ({ mentionPath }) =>
      mentionPath === Mention.SUBJECT_PATH ? NAMES_UNLINKED_ACCOUNT : NAMES_UNLINKED_PROVIDER,
  })

/** Why `resource`, reviewed under `key`, is listed: each reason once, joined. */
const reasonsLine = (key: string, resource: FhirResourceWithId): string =>
  Array.dedupe(unlinkedIn(key, resource).map((one) => reasonOf(one, resource))).join(' · ')

export { groupsOf, isAt, isOfPatient, keysNeedingPatient, reasonsLine, unlinkedIn }
export type { Groups }
