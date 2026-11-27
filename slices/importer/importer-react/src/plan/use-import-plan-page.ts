/**
 * The import plan page's logic: read the picked files into an import plan,
 * resolve it, and write it as one transaction.
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
  planImport,
  readBatchCopies,
  type StoredMatchFailure,
} from '@wildflowerhealthio/importer-core'
import {
  countTotals,
  type ImportPlan,
  ImportWrite,
  type PickedFile,
  type PlanResolution,
  type PlanTotals,
  resolvePlan,
} from '@wildflowerhealthio/importer-fundamentals'
import { positionedTextExtractorPdfjs } from '@wildflowerhealthio/positioned-text-web'
import { Data, DateTime, Effect, Option } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { SOURCE_FILES_QUERY_KEY, STORED_RESOURCES_QUERY_KEY } from '../queries/keys.ts'
import { formatRegistry } from '../registry.ts'
import * as WriteFailure from './write-failure.ts'

/**
 * A plan under review: the picked files as read, the plan of their records,
 * its resolution with the resolution's totals and write, and the instant the
 * files were read at.
 *
 * @remarks
 * `resolution`, `totals` and `write` are always those of `plan`: every
 * action that changes the plan goes through {@link reviewOf}, which resolves
 * it and derives the rest, and commits them together.
 */
interface Review {
  readonly batchCopies: BatchCopies
  readonly plan: ImportPlan.Type
  readonly resolution: PlanResolution.Type
  readonly totals: PlanTotals.Type
  readonly write: ImportWrite.Type
  /**
   * When the files were read: the instant a person's name in use is judged
   * at, so the page names a person the same way however often the plan is
   * resolved again.
   */
  readonly readAt: DateTime.Utc
}

/**
 * Where the page is: choosing files, reading them, unable to plan them,
 * reviewing the plan (with why the last write did not end in an import, when
 * one was sent), writing it, or done.
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
  /** Read `picks` into a plan to review; nothing for no picks. */
  readonly read: (picks: readonly PickedFile.NamedBytes[]) => void
  /** Write the plan under review as one transaction, when it is ready to write. */
  readonly importPlan: () => void
  /** Drop whatever is read, planned or written, and go back to choosing files. */
  readonly startOver: () => void
}

/**
 * `plan` resolved, with its totals and write, beside the files it was read
 * from at `readAt`.
 */
const reviewOf = (
  batchCopies: BatchCopies,
  readAt: DateTime.Utc,
  plan: ImportPlan.Type
): Effect.Effect<Review> =>
  Effect.map(resolvePlan(plan), (resolution): Review => ({
    batchCopies,
    plan,
    resolution,
    totals: countTotals(resolution),
    write: ImportWrite.of(resolution),
    readAt,
  }))

/**
 * `picks` read now and planned against the store: the read's copies of
 * records, matched by `findStoredMatch`, resolved. A failed search fails it,
 * never "no match".
 */
const readReview = (
  picks: readonly PickedFile.NamedBytes[]
): Effect.Effect<Review, StoredMatchFailure, FhirR4ResourcesHttpApiClient> =>
  Effect.all({
    readAt: DateTime.now,
    batchCopies: readBatchCopies(formatRegistry, defaultFormatSettings, picks).pipe(
      Effect.provide(positionedTextExtractorPdfjs)
    ),
  }).pipe(
    Effect.flatMap(({ readAt, batchCopies }) =>
      planImport(copiesOf(batchCopies), findStoredMatch).pipe(
        Effect.flatMap((plan) => reviewOf(batchCopies, readAt, plan))
      )
    )
  )

/** Log why `action` did not finish: `failure` is a rejected run, its cause inside it. */
const logFailure = (action: string, failure: unknown): void => {
  Effect.runSync(Effect.logError(action, failure))
}

/**
 * The import plan page's state and actions, over the authed runner from
 * router context.
 *
 * @remarks
 * The state lives in a ref beside the React state, written together, so an
 * action reads what the next action needs rather than what the last render
 * showed. One ticket drops a read or a write that a later action overtook.
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
  const current = useRef<ImportPlanPageState>(state)
  const latest = useRef(0)

  const commit = useCallback((next: ImportPlanPageState): void => {
    current.current = next
    setState(next)
  }, [])

  const read = useCallback(
    (picks: readonly PickedFile.NamedBytes[]): void => {
      if (picks.length === 0) return
      latest.current += 1
      const ticket = latest.current
      commit(reading())
      void runAuthed(readReview(picks)).then(
        (review) => {
          if (latest.current !== ticket) return
          commit(reviewing({ review, writeFailure: Option.none() }))
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

  const importPlan = useCallback((): void => {
    const pageState = current.current
    if (pageState._tag !== 'Reviewing') return
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
              onSome: (failure) => reviewing({ review, writeFailure: Option.some(failure) }),
            })
          )
        )
      },
      (failure: unknown) => {
        logFailure('The import plan could not be written', failure)
        invalidateWritten()
        if (latest.current !== ticket) return
        commit(reviewing({ review, writeFailure: Option.some(WriteFailure.Unanswered()) }))
      }
    )
  }, [commit, queryClient, runAuthed])

  const startOver = useCallback((): void => {
    latest.current += 1
    commit(choosingFiles())
  }, [commit])

  return { state, read, importPlan, startOver }
}

export { ImportPlanPageState, useImportPlanPage }
export type { ImportPlanPage, Review }
