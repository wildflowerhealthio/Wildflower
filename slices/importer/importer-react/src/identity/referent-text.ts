/**
 * The referent rows' user-visible strings and the helpers that build them,
 * held apart from the components so the rows, the screen and the tests all
 * name the same text.
 *
 * @packageDocumentation
 */

import type { LinkableLogicalReference, Referent } from '@wildflowerhealthio/importer-fundamentals'

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

/** The alert when the files hold one person or provider twice, under different ids, so the import cannot be placed. */
const duplicateReferentMessage = ({
  logicalReference,
  reviewKeys,
}: Referent.DuplicateReferent): string =>
  `These files hold two ${logicalReference.type} records with the identifier ${logicalReference.identifier.value} under different ids (${reviewKeys.join(', ')}). The import cannot tell which one its references mean, so these files cannot be imported together.`

/** The action that leaves the refused batch for another pick. */
const CHOOSE_OTHER_FILES_LABEL = 'Choose other files'

/** The choice that writes the referent's own resource, or a provisional one, as a new record. */
const NEW_LABEL = 'New'

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

/**
 * The warning under a referent linked to a stored resource whose demographics
 * differ: which of them differ, never a block.
 */
const differingDemographicsWarning = (differing: readonly string[]): string =>
  `The record on the server has a different ${differing.join(' and ')}. Check it is the same person.`

/** The family name, as {@link differingDemographicsWarning} names it. */
const FAMILY_NAME = 'family name'

/** The given names, as {@link differingDemographicsWarning} names them. */
const GIVEN_NAME = 'given name'

/** The birth date, as {@link differingDemographicsWarning} names it. */
const BIRTH_DATE = 'birth date'

/** How many referents land where. */
interface ReferentTally {
  readonly onServer: number
  readonly created: number
  readonly unlinked: number
}

/** The tally line: how many referents link to stored records, how many are new, how many neither. */
const referentTallyLine = ({ onServer, created, unlinked }: ReferentTally): string =>
  [
    `${onServer} linked to ${plural(onServer, 'record')} on the server`,
    `${created} new or provisional`,
    ...(unlinked > 0 ? [`${unlinked} not linked`] : []),
  ].join(', ')

export {
  BIRTH_DATE,
  CHOOSE_OTHER_FILES_LABEL,
  differingDemographicsWarning,
  DONT_LINK_LABEL,
  duplicateReferentMessage,
  FAMILY_NAME,
  GIVEN_NAME,
  GROUP_HEADINGS,
  IN_IMPORT_GROUP,
  NEW_LABEL,
  newAsLabel,
  ON_SERVER_GROUP,
  REFERENTS_HEADING,
  referentTallyLine,
  type ReferentTally,
  SEARCH_ERROR_MESSAGE,
  SEARCHING_SERVER_MESSAGE,
  sameAsLabel,
}
