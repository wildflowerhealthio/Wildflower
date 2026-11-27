/**
 * Every sentence, label and plural the import plan page shows, held apart
 * from the components so the page, its tests and the host app's end-to-end
 * assertions all name the same text.
 *
 * @packageDocumentation
 */
import type { BatchEntryOutcome } from '@wildflowerhealthio/fhir-r4/clients'
import { type ExistingRecord, PlanTotals } from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Data, Match, Option } from 'effect'

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
 * What `counts` says of each label: "12 new", "2 updated", "55 linked", then
 * what is not added, not needed and open, each part only when it counts a
 * record.
 */
const labelPartsOf = (counts: PlanTotals.Counts): readonly string[] => {
  const { Create, Update, LinkToExisting, DontAdd, Unneeded, Open } = counts.byLabel
  const parts: readonly (readonly [number, string])[] = [
    [Create, 'new'],
    [Update, 'updated'],
    [LinkToExisting, 'linked'],
    [DontAdd, 'not added'],
    [Unneeded, 'not needed'],
    [Open, 'open'],
  ]
  return parts.filter(([count]) => count > 0).map(([count, word]) => `${count} ${word}`)
}

/**
 * One file set's status line: "69 records · 12 new · 2 updated · 55 linked",
 * then what is not added, not needed and open, each part only when it counts
 * a record.
 */
const fileSetLine = (counts: PlanTotals.Counts): string =>
  [countOf(PlanTotals.recordsOf(counts), 'record'), ...labelPartsOf(counts)].join(' · ')

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

/** What names a record a reviewer is to select something for, as a sentence names it. */
interface RecordToSelect {
  readonly resourceType: string
  /** The record's title in a sentence. */
  readonly title: string
  /** The title of the file set it is listed under. */
  readonly fileTitle: string
}

/**
 * The words before the file's title in a Needs a decision card's title:
 * "Select a Patient record for Tyra Banks from".
 */
const selectRecordLead = ({ resourceType, title }: Omit<RecordToSelect, 'fileTitle'>): string =>
  `Select ${articleFor(resourceType)} ${resourceType} record for ${title} from`

/** A Needs a decision card's title: "Select a Patient record for Tyra Banks from a.har". */
const selectRecordTitle = (record: RecordToSelect): string =>
  `${selectRecordLead(record)} ${record.fileTitle}`

/**
 * The import bar's line while a record has no choice: "Select a Patient
 * record for Tyra Banks from a.har.", the title of its card as a sentence.
 */
const undecidedRecordLine = (record: RecordToSelect): string => `${selectRecordTitle(record)}.`

/** The import bar's action that scrolls to the first record with no choice. */
const GO_TO_RECORD_LABEL = 'Go to record'

/** The line under the Needs a decision heading: why these records are asked about. */
const NEEDS_A_DECISION_LINE =
  'These records were matched on their contents rather than an identifier, or had an identifier that matched more than one existing record.'

/**
 * Why a record needs a decision, as its card's meta line counts it: several
 * existing records carry its identifier (`IdentifierMatches`), or existing
 * records match it by name and other records reference it (`NameMatches`,
 * with the identity fields the imported record states that no match
 * differs on).
 */
type DecisionMatches = Data.TaggedEnum<{
  IdentifierMatches: { readonly count: number }
  NameMatches: { readonly count: number; readonly sameFields: readonly string[] }
}>

const DecisionMatches = Data.taggedEnum<DecisionMatches>()

/**
 * A Needs a decision card's meta line: "Not selected · 2 possible matches ·
 * referenced by 22 records · same name, birthDate". "Not selected" only
 * while nothing is chosen; "N identifier matches" for a record several
 * existing records carry the identifier of, "N possible matches" and the
 * fields they agree on, when any, for a name match; the referrers only when
 * a record references it.
 */
const decisionMetaLine = ({
  isOpen,
  matches,
  referrers,
}: {
  /** Whether nothing is chosen for the record. */
  readonly isOpen: boolean
  readonly matches: DecisionMatches
  readonly referrers: number
}): string =>
  [
    isOpen ? 'Not selected' : null,
    ...DecisionMatches.$match(matches, {
      IdentifierMatches: ({ count }) => [
        countOf(count, 'identifier match', 'identifier matches'),
        referredText(referrers),
      ],
      NameMatches: ({ count, sameFields }) => [
        countOf(count, 'possible match', 'possible matches'),
        referredText(referrers),
        sameFields.length === 0 ? null : `same ${sameFields.join(', ')}`,
      ],
    }),
  ]
    .filter((part) => part !== null)
    .join(' · ')

/** "referenced by 22 records"; `null` when no record references it. */
const referredText = (referrers: number): string | null =>
  referrers === 0 ? null : `referenced by ${countOf(referrers, 'record')}`

/** The kicker of the imported record's option, before its file's title. */
const IMPORTED_KICKER = 'Imported'

/**
 * The parts of an existing record's option's kicker, shown joined by " · "
 * and never broken inside one: "Existing", "updated 2026-06-02", "probable
 * match", the date only when the record says when it was last updated, the
 * grade only when a search matched it.
 */
const existingKicker = ({
  updatedOn,
  knownBy,
}: {
  /** The date it was last updated, `YYYY-MM-DD`. */
  readonly updatedOn: Option.Option<string>
  readonly knownBy: ExistingRecord.KnownBy
}): readonly string[] => [
  'Existing',
  ...Option.toArray(Option.map(updatedOn, (date) => `updated ${date}`)),
  ...Match.value(knownBy).pipe(
    Match.tag('MatchedBySearch', ({ grade }) => [`${grade} match`]),
    Match.tag('StoredUnderDerivedId', 'ChosenByReviewer', (): readonly string[] => []),
    Match.exhaustive
  ),
]

/** Between the parts of an option's kicker: no break before the dot, so it ends a line rather than starting one. */
const KICKER_SEPARATOR = '\u00A0· '

/** The radio label of the imported record's option. */
const SAVE_AS_NEW_LABEL = 'Save as a new record'

/** The radio label of an existing record's option. */
const USE_EXISTING_LABEL = 'Use this existing record'

/** The radio label of the line that leaves the record out. */
const DONT_ADD_LABEL = "Don't add"

/** An option's value for a field it has no value for. */
const NOT_RECORDED = 'Not recorded'

/** Before an identifier a merge adds to an existing record. */
const ADDS_IDENTIFIER_LEAD = 'Adds identifier'

/** The heading over an existing record's differences while its option is not selected. */
const DIFFERENCES_HEADING = 'Differences'

/** Between a field and the value the import gives a field the existing record has no value for. */
const GAINS_WORD = 'gains'

/**
 * Said under the imported record's option once it is selected: "22 records
 * will reference the new record."; `None` when no record references it.
 */
const saveAsNewOutcome = (referrers: number): Option.Option<string> =>
  referrers === 0
    ? Option.none()
    : Option.some(`${countOf(referrers, 'record')} will reference the new record.`)

/** ", with 1 field updated" when a field is taken; nothing when none is. */
const fieldsUpdatedClause = (fieldsUpdated: number): string =>
  fieldsUpdated === 0 ? '' : `, with ${countOf(fieldsUpdated, 'field')} updated`

/**
 * Said under an existing record's option once it is selected: "22 records
 * will reference this record instead, with 1 field updated.", the clause
 * only when a field is taken; when no record references it, "This record
 * will have 1 field updated.", and `None` when no field is taken either.
 */
const existingRecordOutcome = ({
  referrers,
  fieldsUpdated,
}: {
  readonly referrers: number
  readonly fieldsUpdated: number
}): Option.Option<string> => {
  if (referrers > 0) {
    return Option.some(
      `${countOf(referrers, 'record')} will reference this record instead${fieldsUpdatedClause(fieldsUpdated)}.`
    )
  }
  return fieldsUpdated === 0
    ? Option.none()
    : Option.some(`This record will have ${countOf(fieldsUpdated, 'field')} updated.`)
}

/**
 * Said beside Don't add once it is selected: "22 records keep the display
 * “Tyra Banks” with no reference"; `None` when no record references it.
 */
const dontAddOutcome = ({
  referrers,
  title,
}: {
  readonly referrers: number
  /** The record's title in a sentence, which its referrers show it by. */
  readonly title: string
}): Option.Option<string> =>
  referrers === 0
    ? Option.none()
    : Option.some(
        `${countOf(referrers, 'record')} ${referrers === 1 ? 'keeps' : 'keep'} the display “${title}” with no reference`
      )

/**
 * The checkbox that takes the import's fields into an existing record:
 * "Update with import details", then " · 1 of 2" when more than one field
 * differs.
 *
 * @remarks
 * With one differing field the checkbox's own state says all a count
 * would ("1 of 1" or "0 of 1"), so, as in the design's prototype, the count
 * is shown only when there is more than one.
 */
const updateWithImportLabel = ({
  taken,
  differing,
}: {
  readonly taken: number
  readonly differing: number
}): string => `Update with import details${differing > 1 ? ` · ${taken} of ${differing}` : ''}`

/** The kicker over Decided automatically: nothing in it needs the reviewer. */
const DECIDED_AUTOMATICALLY_KICKER = 'Optional'

/** The heading of the records that need no decision. */
const DECIDED_AUTOMATICALLY_HEADING = 'Decided automatically'

/**
 * The line under the Decided automatically heading: "47 records. Matched by
 * identifier, or with no similar existing record. Change any; changes are
 * listed first."
 */
const decidedAutomaticallyLine = (records: number): string =>
  `${countOf(records, 'record')}. Matched by identifier, or with no similar existing record. Change any; changes are listed first.`

/** The heading of the people the other records reference. */
const PEOPLE_HEADING = 'Patient and Practitioner'

/** The line under the people's heading. */
const PEOPLE_LINE = 'Other records reference these.'

/** A group's heading: its records' type and how many there are, "MedicationRequest · 9". */
const recordGroupHeading = (resourceType: string, records: number): string =>
  `${resourceType} · ${records}`

/** A group's status line: "2 new · 7 linked", each part only when it counts a record. */
const recordGroupLine = (counts: PlanTotals.Counts): string => labelPartsOf(counts).join(' · ')

/** The name of a group's menu: "Set every MedicationRequest". */
const setEveryLabel = (resourceType: string): string => `Set every ${resourceType}`

/** The group menu's item that saves every record of the group as a new one: "Create all 9". */
const createAllLabel = (records: number): string => `Create all ${records}`

/** The group menu's item that clears the reviewer's choice for every record of the group. */
const RESET_TO_SUGGESTED_LABEL = 'Reset to suggested'

/** The group menu's item that adds none of the group's records. */
const DONT_ADD_ANY_LABEL = "Don't add any"

/** The action under a group's rows that lists `more` more: "Show 20 more". */
const showMoreLabel = (more: number): string => `Show ${more} more`

/** The line of a group's rows folded away: "12 same as existing". */
const sameAsExistingLine = (records: number): string => `${records} same as existing`

/** The action that unfolds the rows the same as existing ones. */
const SHOW_LABEL = 'Show'

/** The action that folds them away again. */
const HIDE_LABEL = 'Hide'

/** The chip of a row whose choice the reviewer changed from its suggestion. */
const CHANGED_CHIP = 'Changed'

/**
 * What `RecordRow` fills its choice with while nothing is chosen; never shown
 * on a row, since a record decided automatically always has a choice.
 */
const SELECT_PLACEHOLDER = 'Select…'

/**
 * A row's option that merges into an existing record: "Use Tyra Banks",
 * then ", updated" when the merge writes something to it.
 */
const useRecordLabel = ({
  title,
  updates,
}: {
  /** The existing record's title in a sentence. */
  readonly title: string
  readonly updates: boolean
}): string => `Use ${title}${updates ? ', updated' : ''}`

/** The name of a row's choice: "On import: Tyra Banks". */
const onImportLabel = (title: string): string => `On import: ${title}`

/**
 * The tag of a record one existing record carries the identifier of:
 * "Identifier match · same as existing", else "Identifier match · 2 fields
 * differ".
 */
const identifierMatchTag = (differing: number): string =>
  `Identifier match · ${differing === 0 ? 'same as existing' : `${countOf(differing, 'field')} ${differing === 1 ? 'differs' : 'differ'}`}`

/**
 * The tag of a record one existing record carries the identifier of that
 * differs from it on no field, though merging into it still writes to it: an
 * identifier or a link it gains.
 */
const IDENTIFIER_MATCH_ADDS_TAG = 'Identifier match · adds an identifier or a link'

/** The tag of a record no existing record matches. */
const NO_MATCH_TAG = 'New · no match'

/** The tag of a record existing records match by name that no other record references. */
const NOT_REFERENCED_TAG = 'New · not referenced'

/**
 * Said of a record a reference only implied that nothing written references,
 * so it is not written whatever its choice.
 */
const UNNEEDED_LINE = 'Not written: no record written references it'

/**
 * A row's last line: its tag, then, for a record that is not needed,
 * {@link UNNEEDED_LINE}.
 */
const recordReasonLine = ({
  tag,
  isUnneeded,
}: {
  readonly tag: string
  readonly isUnneeded: boolean
}): string => [tag, isUnneeded ? UNNEEDED_LINE : null].filter((part) => part !== null).join(' · ')

/**
 * A person's row's last line: "a.har · New · no match · referenced by 22
 * records", the referrers only when a record references it, then, for a
 * person that is not needed, {@link UNNEEDED_LINE}.
 */
const personReasonLine = ({
  fileTitle,
  tag,
  referrers,
  isUnneeded,
}: {
  /** The title of the file set it is listed under. */
  readonly fileTitle: string
  readonly tag: string
  readonly referrers: number
  readonly isUnneeded: boolean
}): string =>
  [fileTitle, tag, referredText(referrers), isUnneeded ? UNNEEDED_LINE : null]
    .filter((part) => part !== null)
    .join(' · ')

/** A Patient's detail: "1990-01-02 · female", "No birthDate" when it states none. */
const patientDetail = ({
  birthDate,
  gender,
}: {
  readonly birthDate: Option.Option<string>
  readonly gender: Option.Option<string>
}): string =>
  [Option.getOrElse(birthDate, () => 'No birthDate'), ...Option.toArray(gender)].join(' · ')

/** A Practitioner's detail when it carries no identifier. */
const NO_IDENTIFIER = 'No identifier'

/**
 * A reference's part of a row's detail: "subject: Tyra Banks", then " (display
 * only)" when the record it names is not added, so the reference keeps its
 * display alone.
 */
const referencePart = ({
  field,
  display,
  isDisplayOnly,
}: {
  /** The top-level field holding it. */
  readonly field: string
  readonly display: string
  readonly isDisplayOnly: boolean
}): string => `${field}: ${display}${isDisplayOnly ? ' (display only)' : ''}`

/** A row's detail when its record holds no reference with anything to show. */
const NO_REFERENCES = 'No references'

/** A record's detail: its references' parts, "subject: Tyra Banks · requester: Dr. Brown". */
const referencesDetail = (parts: readonly string[]): string =>
  parts.length === 0 ? NO_REFERENCES : parts.join(' · ')

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
  ADDS_IDENTIFIER_LEAD,
  CANCEL_IMPORT_LABEL,
  CHANGED_CHIP,
  CHOOSE_OTHER_FILES_LABEL,
  COMPLETE_HEADING,
  completeLine,
  CountLabel,
  countOf,
  createAllLabel,
  DECIDED_AUTOMATICALLY_HEADING,
  DECIDED_AUTOMATICALLY_KICKER,
  decidedAutomaticallyLine,
  DecisionMatches,
  decisionMetaLine,
  DIFFERENCES_HEADING,
  DONT_ADD_ANY_LABEL,
  DONT_ADD_LABEL,
  dontAddOutcome,
  existingKicker,
  fileSetLine,
  GAINS_WORD,
  GO_TO_RECORD_LABEL,
  HIDE_LABEL,
  IDENTIFIER_MATCH_ADDS_TAG,
  identifierMatchTag,
  IMPORT_MORE_FILES_LABEL,
  IMPORT_PLAN_KICKER,
  importButtonLabel,
  IMPORTED_KICKER,
  KICKER_SEPARATOR,
  NEEDS_A_DECISION_LINE,
  NO_IDENTIFIER,
  NO_MATCH_TAG,
  NO_RECORDS_READ_SENTENCE,
  NO_REFERENCES,
  NOT_RECOGNISED_LINE,
  NOT_RECORDED,
  NOT_REFERENCED_TAG,
  NOTHING_TO_IMPORT_SENTENCE,
  onImportLabel,
  openLine,
  patientDetail,
  PEOPLE_HEADING,
  PEOPLE_LINE,
  personReasonLine,
  READ_FAILED_MESSAGE,
  READING_MESSAGE,
  readySentence,
  recordGroupHeading,
  recordGroupLine,
  recordReasonLine,
  referencePart,
  referencesDetail,
  REFUSED_MESSAGE,
  refusalMessagesOf,
  RESET_TO_SUGGESTED_LABEL,
  sameAsExistingLine,
  SAVE_AS_NEW_LABEL,
  saveAsNewOutcome,
  SELECT_PLACEHOLDER,
  selectRecordLead,
  selectRecordTitle,
  setEveryLabel,
  SHOW_LABEL,
  showMoreLabel,
  summaryTitle,
  UNANSWERED_MESSAGE,
  undecidedRecordLine,
  UNNEEDED_LINE,
  UNREADABLE_LINE,
  updateWithImportLabel,
  USE_EXISTING_LABEL,
  useRecordLabel,
  existingRecordOutcome,
  writeFailureMessage,
}
export type { RecordToSelect }
