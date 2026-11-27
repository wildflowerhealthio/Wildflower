/**
 * The import plan page's logic: read the picked files into an import plan,
 * resolve it, take the reviewer's choices, read a format again when its
 * settings change, and write it as one transaction.
 *
 * @packageDocumentation
 */
import { useQueryClient } from '@tanstack/react-query'
import { useRunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import {
  type FhirR4ResourcesHttpApiClient,
  persistTransactionBundle,
} from '@wildflowerhealthio/fhir-r4/clients'
import {
  type BatchCopies,
  copiesOf,
  defaultFormatSettings,
  findStoredMatch,
  type FormatKind,
  formatKinds,
  type FormatSettings,
  planImport,
  readBatchCopies,
  rereadFormatCopies,
  type StoredMatchFailure,
} from '@wildflowerhealthio/importer-core'
import {
  carryChoices,
  countTotals,
  ImportPlan,
  ImportWrite,
  locateReferences,
  type PickedFile,
  type PlanResolution,
  type PlanTotals,
  type RecordChoice,
  type RecordKey,
  type RecordReferences,
  resolvePlan,
} from '@wildflowerhealthio/importer-fundamentals'
import { positionedTextExtractorPdfjs } from '@wildflowerhealthio/positioned-text-web'
import { Data, DateTime, Effect, Option } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { SOURCE_FILES_QUERY_KEY, STORED_RESOURCES_QUERY_KEY } from '../queries/keys.ts'
import { formatRegistry } from '../registry.ts'
import * as PlanDifferences from './plan-differences.ts'
import * as WriteFailure from './write-failure.ts'

/**
 * A plan under review: the picked files as read and the settings they were
 * read under, the plan of their records, its resolution with the
 * resolution's totals and write, the differences the cards and rows show,
 * who references each record, and the instant the files were read at.
 *
 * @remarks
 * `resolution`, `totals`, `write` and `differences` are always those of
 * `plan`: every action that changes the plan goes through {@link reviewOf},
 * which resolves it and derives the rest, and commits them together.
 */
interface Review {
  readonly batchCopies: BatchCopies
  /** Every format's settings, as its files were read under them. */
  readonly settings: FormatSettings
  readonly plan: ImportPlan.Type
  readonly resolution: PlanResolution.Type
  readonly totals: PlanTotals.Type
  readonly write: ImportWrite.Type
  /** What merging each record that has an existing record into each of its candidates would change. */
  readonly differences: PlanDifferences.Type
  /**
   * Who references each record, located when the files are read: a choice
   * changes where a reference lands, never which record it names.
   */
  readonly recordReferences: RecordReferences.Type
  /**
   * When the files were first read: the instant a person's name in use is
   * judged at, so the page names a person the same way however often the
   * plan is resolved or read again.
   */
  readonly readAt: DateTime.Utc
}

/** What a review is read from, the plan aside: what every plan of it is reviewed beside. */
type ReviewedRead = Pick<Review, 'batchCopies' | 'settings' | 'readAt' | 'recordReferences'>

/**
 * Whether the plan shown was read under the reviewer's settings: `Applied`
 * when the review was read under every format's current settings,
 * `Rereading` while the files are read again under them (the plan shown
 * stays, and cannot be imported until the read lands), else `NotApplied`
 * for the formats whose settings differ from those the review was read
 * under: the plan shown, and what Import writes, is the one read before.
 * Derived, never kept: {@link settingsStatusOf}.
 */
type SettingsStatus = Data.TaggedEnum<{
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  Applied: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  Rereading: Record<never, never>
  NotApplied: { readonly formats: readonly FormatKind[] }
}>

const SettingsStatus = Data.taggedEnum<SettingsStatus>()

/**
 * Where the page is: choosing files, reading them, unable to plan them,
 * reviewing the plan, writing it, or done.
 *
 * @remarks
 * While reviewing it keeps only what cannot be read off the review and the
 * settings: why the last write did not end in an import, when one was sent;
 * whether the files are being read again under changed settings; and the
 * keys of the records whose reviewer's choice the last read again could not
 * keep (`CarriedChoices.notCarried`), said until the reviewer's next
 * choice, reset, read again or import. Whether the settings shown were
 * applied is derived ({@link settingsStatusOf}).
 */
type ImportPlanPageState = Data.TaggedEnum<{
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  ChoosingFiles: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  Reading: Record<never, never>
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  ReadFailed: Record<never, never>
  Reviewing: {
    readonly review: Review
    readonly writeFailure: Option.Option<WriteFailure.Type>
    readonly isRereading: boolean
    readonly choicesNotKept: readonly RecordKey.Type[]
  }
  Importing: { readonly review: Review }
  Imported: { readonly review: Review }
}>

const ImportPlanPageState = Data.taggedEnum<ImportPlanPageState>()
const {
  ChoosingFiles: choosingFiles,
  Reading: reading,
  ReadFailed: readFailed,
  Reviewing: reviewing,
  Importing: importing,
  Imported: imported,
} = ImportPlanPageState

/** What the page drives the import through. */
interface ImportPlanPage {
  readonly state: ImportPlanPageState
  /** Every format's settings as the reviewer last set them: what the next read runs under. */
  readonly settings: FormatSettings
  /** Read `picks` into a plan to review; nothing for no picks. */
  readonly read: (picks: readonly PickedFile.NamedBytes[]) => void
  /**
   * Make `choice` the reviewer's choice for every record under one of
   * `keys`, while reviewing, keeping the last write's failure.
   */
  readonly choose: (keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type) => void
  /**
   * Clear the reviewer's choice for every record under one of `keys`, back
   * to its suggestion, while reviewing, keeping the last write's failure.
   */
  readonly reset: (keys: Iterable<RecordKey.Type>) => void
  /**
   * Make `formatSettings` the settings of `format`, and, while reviewing,
   * read that format's files again under them, plan the batch again and
   * carry the reviewer's choices over.
   */
  readonly applySettings: <K extends FormatKind>(
    format: K,
    formatSettings: FormatSettings[K]
  ) => void
  /**
   * While reviewing, read again every format whose settings were not
   * applied to the plan under review, as a settings change does.
   */
  readonly applySettingsAgain: () => void
  /** Write the plan under review as one transaction, when it is ready to write. */
  readonly importPlan: () => void
  /** Drop whatever is read, planned or written, and go back to choosing files, keeping the settings. */
  readonly startOver: () => void
}

/** `plan` resolved, with its totals, its write and its differences, beside what it was `read` from. */
const reviewOf = (read: ReviewedRead, plan: ImportPlan.Type): Effect.Effect<Review> =>
  Effect.map(resolvePlan(plan), (resolution): Review => ({
    ...read,
    plan,
    resolution,
    totals: countTotals(resolution),
    write: ImportWrite.of(resolution),
    differences: PlanDifferences.ofPlan(plan),
  }))

/** Who references each record of `plan`. */
const recordReferencesOf = (plan: ImportPlan.Type): RecordReferences.Type =>
  locateReferences(plan.records.map(({ record }) => record))

/** A batch as read under `settings` and its plan as suggested against the store. */
interface PlannedBatch {
  readonly batchCopies: BatchCopies
  readonly plan: ImportPlan.Type
}

/**
 * `batchCopies` planned against the store: its copies of records, matched by
 * `findStoredMatch`. A failed search fails it, never "no match".
 */
const planBatch = (
  batchCopies: BatchCopies
): Effect.Effect<PlannedBatch, StoredMatchFailure, FhirR4ResourcesHttpApiClient> =>
  Effect.map(planImport(copiesOf(batchCopies), findStoredMatch), (plan) => ({
    batchCopies,
    plan,
  }))

/**
 * `picks` read now under `settings` and planned against the store, resolved.
 * A failed search fails it, never "no match".
 */
const readReview = (
  settings: FormatSettings,
  picks: readonly PickedFile.NamedBytes[]
): Effect.Effect<Review, StoredMatchFailure, FhirR4ResourcesHttpApiClient> =>
  Effect.all({
    readAt: DateTime.now,
    planned: readBatchCopies(formatRegistry, settings, picks).pipe(
      Effect.provide(positionedTextExtractorPdfjs),
      Effect.flatMap(planBatch)
    ),
  }).pipe(
    Effect.flatMap(({ readAt, planned: { batchCopies, plan } }) =>
      reviewOf({ batchCopies, settings, readAt, recordReferences: recordReferencesOf(plan) }, plan)
    )
  )

/** The formats whose settings differ between `readUnder`, as a batch was read, and `settings`, in registry order. */
const formatsChangedBetween = (
  readUnder: FormatSettings,
  settings: FormatSettings
): readonly FormatKind[] => formatKinds.filter((format) => readUnder[format] !== settings[format])

/**
 * `review`'s batch with every format whose settings differ in `settings`
 * read again under them (`rereadFormatCopies`), the other formats as read,
 * and the whole batch planned again against the store, as suggested: a
 * setting can change a record's identifier, and so what the store holds of
 * it. A failed search fails it.
 */
const rereadBatch = (
  review: Review,
  settings: FormatSettings
): Effect.Effect<PlannedBatch, StoredMatchFailure, FhirR4ResourcesHttpApiClient> =>
  Effect.reduce(
    formatsChangedBetween(review.settings, settings),
    review.batchCopies,
    (batchCopies, format) => rereadFormatCopies(formatRegistry, settings, format, batchCopies)
  ).pipe(Effect.provide(positionedTextExtractorPdfjs), Effect.flatMap(planBatch))

/**
 * Whether the plan of `review` was read under `settings`: `Rereading` while
 * the files are read again, else `Applied`, or `NotApplied` for the formats
 * whose settings differ from those `review` was read under.
 */
const settingsStatusOf = (
  review: Review,
  isRereading: boolean,
  settings: FormatSettings
): SettingsStatus => {
  if (isRereading) return SettingsStatus.Rereading()
  const formats = formatsChangedBetween(review.settings, settings)
  return formats.length === 0 ? SettingsStatus.Applied() : SettingsStatus.NotApplied({ formats })
}

/** `review` under review, its last write's failure `writeFailure`, nothing read again or dropped. */
const reviewingSettled = (
  review: Review,
  writeFailure: Option.Option<WriteFailure.Type>
): ImportPlanPageState =>
  reviewing({ review, writeFailure, isRereading: false, choicesNotKept: [] })

/** What the next action reads: where the page is, and the settings the next read runs under. */
interface Current {
  readonly page: ImportPlanPageState
  readonly settings: FormatSettings
}

/** Log why `action` did not finish: `failure` is a rejected run, its cause inside it. */
const logFailure = (action: string, failure: unknown): void => {
  Effect.runSync(Effect.logError(action, failure))
}

/**
 * The import plan page's state and actions, over the authed runner from
 * router context.
 *
 * @remarks
 * The state and the settings live in a ref beside the React state, written
 * together, so an action reads what the next action needs rather than what
 * the last render showed: two settings changes in one tick compose. A
 * choice, or a reset back to the suggestion, is only taken while reviewing,
 * never while the write is in flight. The last write's failure stays on
 * screen through later choices, resets and reads again, since the reviewer
 * reads it while fixing the plan and what it says stays true; pressing
 * Import again or starting over clears it.
 *
 * A settings change while reviewing reads again every format whose settings
 * differ from those the review was read under, so a change made while
 * another read is in flight is not lost, plans the whole batch again, and
 * carries the reviewer's choices over from the plan under review when the
 * read lands (`carryChoices`), so a choice made meanwhile is kept, and
 * keeps the keys of the choices it could not carry until the reviewer's next
 * choice, reset, read again or import. The plan under review stays on
 * screen while it runs, and cannot be imported: the page is never unmounted
 * under the settings field being typed in. A read that fails keeps the plan
 * under review and the settings as set, so the review is not of them
 * ({@link settingsStatusOf}), whichever action comes after; a settings
 * change while not reviewing is kept the same way. Starting over keeps the
 * settings for the next files read.
 *
 * One ticket drops a read, a read again or a write that a later action overtook.
 * A write that was sent invalidates the source-file list and the stored
 * records whether or not it is stale: it may have landed either way. A run
 * that fails, the runner's own rejection or a defect included, is logged:
 * a read ends in `ReadFailed`, a write back in `Reviewing` with its failure,
 * `Unanswered` when nothing says whether it landed.
 */
const useImportPlanPage = (): ImportPlanPage => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  const [state, setState] = useState<ImportPlanPageState>(choosingFiles())
  const [settings, setSettings] = useState<FormatSettings>(defaultFormatSettings)
  const current = useRef<Current>({ page: state, settings })
  const latest = useRef(0)

  const commit = useCallback((next: ImportPlanPageState): void => {
    current.current = { ...current.current, page: next }
    setState(next)
  }, [])

  const commitSettings = useCallback((next: FormatSettings): void => {
    current.current = { ...current.current, settings: next }
    setSettings(next)
  }, [])

  const read = useCallback(
    (picks: readonly PickedFile.NamedBytes[]): void => {
      if (picks.length === 0) return
      latest.current += 1
      const ticket = latest.current
      commit(reading())
      void runAuthed(readReview(current.current.settings, picks)).then(
        (review) => {
          if (latest.current !== ticket) return
          commit(reviewingSettled(review, Option.none()))
        },
        (failure: unknown) => {
          logFailure('The picked files could not be planned', failure)
          if (latest.current !== ticket) return
          commit(readFailed())
        }
      )
    },
    [commit, runAuthed]
  )

  const revise = useCallback(
    (revisePlan: (plan: ImportPlan.Type) => ImportPlan.Type): void => {
      const pageState = current.current.page
      if (pageState._tag !== 'Reviewing') return
      const review = Effect.runSync(reviewOf(pageState.review, revisePlan(pageState.review.plan)))
      commit(reviewing({ ...pageState, review, choicesNotKept: [] }))
    },
    [commit]
  )

  const choose = useCallback(
    (keys: Iterable<RecordKey.Type>, choice: RecordChoice.Type): void => {
      revise((plan) => ImportPlan.choose(plan, keys, choice))
    },
    [revise]
  )

  const reset = useCallback(
    (keys: Iterable<RecordKey.Type>): void => {
      revise((plan) => ImportPlan.reset(plan, keys))
    },
    [revise]
  )

  const readAgain = useCallback((): void => {
    const pageState = current.current.page
    if (pageState._tag !== 'Reviewing') return
    const settingsNow = current.current.settings
    latest.current += 1
    const ticket = latest.current
    commit(reviewing({ ...pageState, isRereading: true, choicesNotKept: [] }))
    void runAuthed(rereadBatch(pageState.review, settingsNow)).then(
      ({ batchCopies, plan }) => {
        const landedOn = current.current.page
        if (latest.current !== ticket || landedOn._tag !== 'Reviewing') return
        const { plan: carried, notCarried } = carryChoices(landedOn.review.plan, plan)
        const review = Effect.runSync(
          reviewOf(
            {
              batchCopies,
              settings: settingsNow,
              readAt: landedOn.review.readAt,
              recordReferences: recordReferencesOf(carried),
            },
            carried
          )
        )
        commit(reviewing({ ...landedOn, review, isRereading: false, choicesNotKept: notCarried }))
      },
      (failure: unknown) => {
        logFailure('The files could not be read again under the new settings', failure)
        const landedOn = current.current.page
        if (latest.current !== ticket || landedOn._tag !== 'Reviewing') return
        commit(reviewing({ ...landedOn, isRereading: false }))
      }
    )
  }, [commit, runAuthed])

  const applySettings = useCallback(
    <K extends FormatKind>(format: K, formatSettings: FormatSettings[K]): void => {
      commitSettings({ ...current.current.settings, [format]: formatSettings })
      readAgain()
    },
    [commitSettings, readAgain]
  )

  const importPlan = useCallback((): void => {
    const pageState = current.current.page
    if (pageState._tag !== 'Reviewing' || pageState.isRereading) return
    const { review } = pageState
    const { write } = review
    if (write._tag !== 'Ready' || ImportWrite.isNothingToImport(write)) return
    latest.current += 1
    const ticket = latest.current
    commit(importing({ review }))
    const invalidateWritten = (): void => {
      void queryClient.invalidateQueries({ queryKey: SOURCE_FILES_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: STORED_RESOURCES_QUERY_KEY })
    }
    void runAuthed(persistTransactionBundle(write.resources)).then(
      (outcomes) => {
        invalidateWritten()
        if (latest.current !== ticket) return
        commit(
          WriteFailure.fromOutcomes(outcomes).pipe(
            Option.match({
              onNone: () => imported({ review }),
              onSome: (failure) => reviewingSettled(review, Option.some(failure)),
            })
          )
        )
      },
      (failure: unknown) => {
        logFailure('The import plan could not be written', failure)
        invalidateWritten()
        if (latest.current !== ticket) return
        commit(reviewingSettled(review, Option.some(WriteFailure.Unanswered())))
      }
    )
  }, [commit, queryClient, runAuthed])

  const startOver = useCallback((): void => {
    latest.current += 1
    commit(choosingFiles())
  }, [commit])

  return {
    state,
    settings,
    read,
    choose,
    reset,
    applySettings,
    applySettingsAgain: readAgain,
    importPlan,
    startOver,
  }
}

export { ImportPlanPageState, SettingsStatus, settingsStatusOf, useImportPlanPage }
export type { ImportPlanPage, Review }
