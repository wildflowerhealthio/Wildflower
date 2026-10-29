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
  LINKED_RECORDS_HEADING,
  LINKED_RECORDS_NOTE,
  NO_RESOURCES_MESSAGE,
  NOTHING_TO_IMPORT_HEADING,
  plural,
  PREVIEW_HEADING,
  UNREADABLE_FILE_MESSAGE,
  UNRECOGNIZED_FILE_MESSAGE,
}
