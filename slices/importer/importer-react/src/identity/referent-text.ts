/**
 * The referent rows' user-visible strings and the helpers that build them,
 * held apart from the components so the rows, the screen and the tests all
 * name the same text.
 *
 * @packageDocumentation
 */

import type {
  DifferingDemographics,
  LinkableLogicalReference,
  Referent,
  ReferentTally,
} from '@wildflowerhealthio/importer-fundamentals'

import { plural } from '../preview/preview-text.ts'

/** The heading of the block above the format groups. */
const REFERENTS_HEADING = 'People and providers in this import'

/** The heading over each resource type's referents. */
const GROUP_HEADINGS: Readonly<Record<LinkableLogicalReference.ResourceType, string>> = {
  Patient: 'People',
  Practitioner: 'Providers',
}

/** The status line while the default search is in flight. */
const SEARCHING_SERVER_MESSAGE = 'Looking for these people and providers on the server…'

/** The alert when the default search failed. */
const SEARCH_ERROR_MESSAGE =
  'Could not search the server for these people and providers. Each starts as new, or not linked.'

/** The alert under a group whose stored list could not be read: only the search's hits are offered. */
const STORED_LIST_ERROR_MESSAGE =
  'Could not list the records on the server. Only the ones the search found are offered.'

/** The note under a group whose stored list the page limit cut off. */
const STORED_LIST_TRUNCATED_MESSAGE =
  'The server holds more records than are offered here. Only the first pages were read.'

/** The alert when the files hold one person or provider twice, under different ids, so the import cannot be placed. */
const duplicateReferentMessage = ({
  logicalReference,
  reviewKeys,
}: Referent.DuplicateReferent): string =>
  `These files hold two ${logicalReference.type} records with the identifier ${logicalReference.identifier.value} under different ids (${reviewKeys.join(', ')}). The import cannot tell which one its references mean, so these files cannot be imported together.`

/** Under the refusal, when the review shown is the batch as it placed before the change that refused it. */
const REFUSED_OVER_PREVIOUS_HINT =
  'The review below is from before that change. Undo it, or choose other files.'

/** The action that leaves the refused batch for another pick. */
const CHOOSE_OTHER_FILES_LABEL = 'Choose other files'

/** The choice that writes the referent's own resource, or a provisional one, as a new record. */
const NEW_LABEL = 'New'

/** The choice that writes the referent's own resource over the stored copy the search found under its id. */
const UPDATE_LABEL = 'Update the record on the server'

/** The choice that leaves a referent's mentions as they are. */
const DONT_LINK_LABEL = "Don't link"

/** The option group of stored resources. */
const ON_SERVER_GROUP = 'On the server'

/** The option group of the records other referents of this import create. */
const IN_IMPORT_GROUP = 'In this import'

/** A choice of the new record another referent of this import creates. */
const newAsLabel = (label: string): string => `New: ${label}`

/** A choice of another referent that no longer creates a record of its own. */
const sameAsLabel = (label: string): string => `Same as: ${label}`

/** Each compared demographic as {@link differingDemographicsWarning} names it. */
const DEMOGRAPHIC_NAMES: Readonly<Record<DifferingDemographics.Demographic, string>> = {
  FamilyName: 'family name',
  GivenName: 'given name',
  BirthDate: 'birth date',
}

/**
 * The warning under a referent linked to a stored resource whose demographics
 * differ: which of them differ, never a block.
 */
const differingDemographicsWarning = (
  differing: readonly DifferingDemographics.Demographic[]
): string =>
  `The record on the server has a different ${differing.map((demographic) => DEMOGRAPHIC_NAMES[demographic]).join(' and ')}. Check it is the same person.`

/** The tally line: how many stored records are linked to, how many records this import writes, how many referents are neither. */
const referentTallyLine = ({ onServer, fromImport, unlinked }: ReferentTally.Type): string =>
  [
    `${onServer} ${plural(onServer, 'record')} on the server`,
    `${fromImport} ${plural(fromImport, 'record')} from this import`,
    ...(unlinked > 0 ? [`${unlinked} not linked`] : []),
  ].join(', ')

export {
  CHOOSE_OTHER_FILES_LABEL,
  differingDemographicsWarning,
  DONT_LINK_LABEL,
  duplicateReferentMessage,
  GROUP_HEADINGS,
  IN_IMPORT_GROUP,
  NEW_LABEL,
  newAsLabel,
  ON_SERVER_GROUP,
  REFERENTS_HEADING,
  referentTallyLine,
  REFUSED_OVER_PREVIOUS_HINT,
  SEARCH_ERROR_MESSAGE,
  SEARCHING_SERVER_MESSAGE,
  sameAsLabel,
  STORED_LIST_ERROR_MESSAGE,
  STORED_LIST_TRUNCATED_MESSAGE,
  UPDATE_LABEL,
}
