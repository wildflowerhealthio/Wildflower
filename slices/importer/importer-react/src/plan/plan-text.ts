/**
 * Every sentence, label and plural the import plan page shows, held apart
 * from the components so the page, its tests and the host app's end-to-end
 * assertions all name the same text.
 *
 * @packageDocumentation
 */
import type { BatchEntryOutcome } from '@wildflowerhealthio/fhir-r4/clients'
import { PlanTotals } from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr } from 'effect'

import * as WriteFailure from './write-failure.ts'

/** The kicker over the summary card's title: the plan is not written yet. */
const IMPORT_PLAN_KICKER = 'Import plan · not imported yet'

/** The heading once the plan is written. */
const COMPLETE_HEADING = 'Import complete'

/** Said while the picked files are read and the existing records searched. */
const READING_MESSAGE = 'Reading the files and searching for existing records…'

/** Said when the files could not be read and planned against the existing records. */
const READ_FAILED_MESSAGE =
  'These files could not be planned against the existing records. Nothing was imported.'

/** The action that drops the files read and goes back to choosing. */
const CHOOSE_OTHER_FILES_LABEL = 'Choose other files'

/** The action that drops the plan and goes back to choosing files. */
const CANCEL_IMPORT_LABEL = 'Cancel import'

/** The action after an import that goes back to choosing files. */
const IMPORT_MORE_FILES_LABEL = 'Import more files'

/** The line of a picked file no format recognised. */
const NOT_RECOGNISED_LINE = 'Not a recognised format'

/** The line of a picked file its format could not read. */
const UNREADABLE_LINE = 'Could not be read'

/** The import bar's sentence when every record is the same as an existing one. */
const NOTHING_TO_IMPORT_SENTENCE =
  'Nothing to import. Every record is the same as an existing record.'

/** The import bar's sentence when no record could be read from the picked files. */
const NO_RECORDS_READ_SENTENCE = 'No records could be read from these files.'

/** Said when the transaction was refused, so nothing was written. */
const REFUSED_MESSAGE = 'No records were written. The import plan is kept.'

/** Said when no answer came back, so the transaction may have been written. */
const UNANSWERED_MESSAGE =
  'No answer came back, so it is not known whether the records were written. The import plan is kept.'

/** What a write failure says: refused, or unanswered. */
const writeFailureMessage = (failure: WriteFailure.Type): string =>
  WriteFailure.match(failure, {
    Refused: () => REFUSED_MESSAGE,
    Unanswered: () => UNANSWERED_MESSAGE,
  })

/** The summary card's count labels, in the order the card shows them. */
const CountLabel = {
  Create: 'Create',
  Update: 'Update',
  LinkToExisting: 'Link to existing',
  NeedsDecision: 'Needs a decision',
} as const

/** `count` beside `noun`, singular for one, else `nouns` (`noun` + "s" by default). */
const countOf = (count: number, noun: string, nouns = `${noun}s`): string =>
  `${count} ${count === 1 ? noun : nouns}`

/** The summary card's title: "47 records from 3 files". */
const summaryTitle = (records: number, files: number): string =>
  `${countOf(records, 'record')} from ${countOf(files, 'file')}`

/** Under the Needs a decision count: how many records still have no choice. */
const openLine = (open: number): string => `${open} open`

/**
 * One file set's status line: "69 records · 12 new · 2 updated · 55 linked",
 * then what is not added, not needed and open, each part only when it counts
 * a record.
 */
const fileSetLine = (counts: PlanTotals.Counts): string => {
  const { Create, Update, LinkToExisting, DontAdd, Unneeded, Open } = counts.byLabel
  const parts: readonly (readonly [number, string])[] = [
    [Create, 'new'],
    [Update, 'updated'],
    [LinkToExisting, 'linked'],
    [DontAdd, 'not added'],
    [Unneeded, 'not needed'],
    [Open, 'open'],
  ]
  return [
    countOf(PlanTotals.recordsOf(counts), 'record'),
    ...parts.filter(([count]) => count > 0).map(([count, word]) => `${count} ${word}`),
  ].join(' · ')
}

/** What a write creates, updates and links: "47 new, 2 updated, 65 linked". */
const writtenCounts = (counts: PlanTotals.Counts): string =>
  `${counts.byLabel.Create} new, ${counts.byLabel.Update} updated, ${counts.byLabel.LinkToExisting} linked`

/** The Import button's label: "Import · 47 new, 2 updated, 65 linked". */
const importButtonLabel = (counts: PlanTotals.Counts): string => `Import · ${writtenCounts(counts)}`

/**
 * The import bar's sentence for a plan ready to write: how many records are
 * not added, when any is, then that the write is one transaction.
 */
const readySentence = (counts: PlanTotals.Counts): string =>
  `${counts.byLabel.DontAdd === 0 ? '' : `${countOf(counts.byLabel.DontAdd, 'record')} not added. `}Written as one transaction: all records or none.`

/** "a" or "an" before `word`, by its first letter. */
const articleFor = (word: string): string => (/^[AEIOU]/iu.test(word) ? 'an' : 'a')

/**
 * The import bar's line while a record has no choice: "Select a Patient
 * record for Tyra Banks from a.har.", `title` the record's title in a
 * sentence and `fileTitle` the title of the file set it is listed under.
 */
const undecidedRecordLine = ({
  resourceType,
  title,
  fileTitle,
}: {
  readonly resourceType: string
  readonly title: string
  readonly fileTitle: string
}): string =>
  `Select ${articleFor(resourceType)} ${resourceType} record for ${title} from ${fileTitle}.`

/** The line under the complete heading: "47 new, 2 updated, 65 linked." */
const completeLine = (counts: PlanTotals.Counts): string => `${writtenCounts(counts)}.`

/**
 * What was said when the transaction was refused: each distinct issue
 * message, in the order the outcomes give them, or an outcome's status when
 * it carries no message.
 */
const refusalMessagesOf = (outcomes: readonly BatchEntryOutcome[]): readonly string[] =>
  Arr.dedupe(
    outcomes.flatMap(({ issues, status }) => {
      const messages = issues.map(({ text }) => text).filter((text) => text !== '')
      return messages.length === 0 ? [status] : messages
    })
  )

export {
  CANCEL_IMPORT_LABEL,
  CHOOSE_OTHER_FILES_LABEL,
  COMPLETE_HEADING,
  completeLine,
  CountLabel,
  countOf,
  fileSetLine,
  IMPORT_MORE_FILES_LABEL,
  IMPORT_PLAN_KICKER,
  importButtonLabel,
  NO_RECORDS_READ_SENTENCE,
  NOT_RECOGNISED_LINE,
  NOTHING_TO_IMPORT_SENTENCE,
  openLine,
  READ_FAILED_MESSAGE,
  READING_MESSAGE,
  readySentence,
  REFUSED_MESSAGE,
  refusalMessagesOf,
  summaryTitle,
  UNANSWERED_MESSAGE,
  undecidedRecordLine,
  UNREADABLE_LINE,
  writeFailureMessage,
}
