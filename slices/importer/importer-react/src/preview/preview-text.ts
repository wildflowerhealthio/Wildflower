/**
 * The preview's user-visible strings and the one-line helpers that build
 * them, held apart from the components so the panel, the review body and the
 * host app's end-to-end assertions all name the same text.
 *
 * @packageDocumentation
 */

/** Heading for a batch with nothing chosen — no resource is included. */
const NOTHING_TO_IMPORT_HEADING = 'Nothing to import'

/** Heading for a batch that has resources to write. */
const PREVIEW_HEADING = 'Ready to import'

/** Message for a unit that did not parse at all. */
const UNREADABLE_FILE_MESSAGE = 'This file could not be read.'

/** Message for a file no registered format recognized. */
const UNRECOGNIZED_FILE_MESSAGE = 'This file was not a format the importer recognizes.'

/** Message for a read file whose decode yielded no importable resources. */
const NO_RESOURCES_MESSAGE = 'No importable resources in this file.'

/** Heading of the batch's linked records: the records it names but holds no copy of. */
const LINKED_RECORDS_HEADING = 'Linked records'

/**
 * The note under the linked records: what they are, and that they are
 * written as the referents link them, not reviewed one by one.
 */
const LINKED_RECORDS_NOTE =
  'Records this import names but holds no copy of, written as the people and providers above link them: a record on the server with this import’s identifiers added, or a new record made from the mention.'

/** The heading over a format's resources whose patient no mention links. */
const NEEDS_A_PATIENT_HEADING = 'Needs a patient'

/** The heading over a format's resources whose patient is linked but a provider is not. */
const NEEDS_A_PROVIDER_HEADING = 'Needs a provider'

/** Why a resource is listed: it has no `subject`, or one naming no one. */
const NAMES_NO_PATIENT = 'names no patient'

/** Why a resource is listed: its patient is an account the reviewer left unlinked. */
const NAMES_UNLINKED_ACCOUNT = 'names an account you chose not to link'

/** Why a resource is listed: a provider it names was left unlinked. */
const NAMES_UNLINKED_PROVIDER = 'names a provider you chose not to link'

/** Why a resource is listed: its `subject` is an absolute URL into another system. */
const POINTS_OUTSIDE_IMPORT = 'points outside this import'

/** The first field of a mention's path: `performer[0].actor` is `performer`. */
const fieldOfPath = (mentionPath: string): string => mentionPath.split(/[[.]/u)[0] ?? mentionPath

/** The words before a mention's select on a row, by the field its path starts in. */
const MENTION_LEADS: Readonly<Record<string, string>> = {
  subject: 'for',
  requester: 'requested by',
  performer: 'performed by',
  resultsInterpreter: 'interpreted by',
  recorder: 'recorded by',
  asserter: 'asserted by',
  author: 'written by',
}

/** The words before the select of the mention at `mentionPath`: "for", "requested by", else the field it sits in. */
const mentionLead = (mentionPath: string): string =>
  MENTION_LEADS[fieldOfPath(mentionPath)] ?? `in ${fieldOfPath(mentionPath)}`

/** What the select of the mention at `mentionPath` is named for: "Patient" for a subject, else its field, capitalised. */
const mentionRole = (mentionPath: string): string => {
  const field = fieldOfPath(mentionPath)
  return field === 'subject' ? 'Patient' : field.charAt(0).toUpperCase() + field.slice(1)
}

/** `noun` singular when `count === 1`, else its `-s` plural. */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`)

/** The confirm button's label, factored out so the render stays a single expression. */
const confirmLabel = (writable: number, excluded: number, confirming: boolean): string => {
  if (confirming) return 'Importing…'
  const base = `Import ${writable} ${plural(writable, 'resource')}`
  return excluded > 0 ? `${base} (${excluded} excluded)` : base
}

export {
  confirmLabel,
  fieldOfPath,
  LINKED_RECORDS_HEADING,
  LINKED_RECORDS_NOTE,
  mentionLead,
  mentionRole,
  NAMES_NO_PATIENT,
  NAMES_UNLINKED_ACCOUNT,
  NAMES_UNLINKED_PROVIDER,
  NEEDS_A_PATIENT_HEADING,
  NEEDS_A_PROVIDER_HEADING,
  NO_RESOURCES_MESSAGE,
  NOTHING_TO_IMPORT_HEADING,
  plural,
  POINTS_OUTSIDE_IMPORT,
  PREVIEW_HEADING,
  UNREADABLE_FILE_MESSAGE,
  UNRECOGNIZED_FILE_MESSAGE,
}
