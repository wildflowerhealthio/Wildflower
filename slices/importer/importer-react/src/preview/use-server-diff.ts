import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { useRunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import { classifyAgainstServer, type ServerComparison } from '@wildflowerhealthio/fhir-r4/clients'
import { type FhirResourceWithId, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import type { StagedImport } from '@wildflowerhealthio/importer-fundamentals'
import { DecodedFile } from '@wildflowerhealthio/importer-fundamentals'

import type { FormatKind, ResolvedBatch, ReviewGroup } from '@wildflowerhealthio/importer-core'
import { formatKinds, keysWithoutPatientOf, LINKED_GROUP } from '@wildflowerhealthio/importer-core'
import { IMPORTER_QUERY_KEY } from '../queries/keys.ts'

/**
 * Pre-fetch the server's copy for every previewed resource in a batch and
 * classify each as `new` / `unchanged` / `changed` — the diff badge the
 * preview row shows the reviewer, and what the "opt out of a re-import"
 * default reads (an `unchanged` row is out unless the reviewer ticks it).
 *
 * @remarks
 * The classification is a TanStack Query, so the shell can **block on it**
 * (the `loading` state gates the preview) rather than paint the panel first
 * and let badges pop in a second later. One `POST /` batch of GET entries
 * fetches every id at once, so a review across two dozen files is still one
 * round trip.
 *
 * `loading` means "nothing worth showing yet", which is narrower than "a
 * request is in flight". A settings change or a link choice changes the
 * batch, which starts a *second* classification for the same batch, and
 * reporting `loading` for that one would unmount the whole preview — taking
 * the focus of whatever control the reviewer is using with it. So the hook
 * keeps the verdicts the batch last settled on, and while the changed batch's
 * own load it reports those as `ready` with `refreshing`, swapping in the new
 * verdicts when they land. A classification that failed settled on "every id
 * is new", so a batch whose first diff failed keeps its panel up too. A
 * *fresh pick* is a new batch and gets no such carry-over: its badges would
 * be about the last batch's files.
 *
 * The hook never blocks *confirming*: the classifier's own error channel is
 * `never` (a whole-bundle transport error attributes every id to `new` inside
 * `classifyAgainstServer`), and if `runAuthed` itself rejects on an auth
 * defect the query is retried twice and then surfaces as an `error` state
 * whose `comparisons` fall back to "every id is new" so the shell still
 * resolves to a writable batch rather than stalling — but the error is
 * visible in the UI.
 *
 * @packageDocumentation
 */

/** One labeled resource, the group it is reviewed in, and the value the classifier probes for it. */
interface DiffRow {
  readonly group: ReviewGroup
  readonly key: string
  readonly resource: FhirResourceWithId
}

/**
 * Every previewed resource's server comparison, keyed by the group it is
 * reviewed in and then by `DecodedFile.Resource`'s `key` within the group.
 *
 * @remarks
 * A resource key is unique within one format — a per-file decode's keys are
 * namespaced by the file they came from (`FormatDecode.keyPrefix`), so
 * DICOM's fixed `patient` / `imaging-study` and every format's source-file
 * row stay distinct across the files a format claimed. Across formats they
 * are not: two formats may both key a row `0:a.json/patient`. Scoping by
 * group is what keeps each format's badges and defaults its own; the
 * linked records, no format's, are the {@link LINKED_GROUP}.
 */
type GroupComparisons = ReadonlyMap<ReviewGroup, ReadonlyMap<string, ServerComparison>>

/**
 * The state of the pre-fetch: `loading` while there is nothing worth showing
 * for this batch (the shell paints a loader instead of the preview), `ready`
 * once there is — the verdicts for this batch, or the ones it last settled on
 * while the changed batch's own are in flight, `error` when the auth-path or
 * network request failed after its retries — the shell shows an error and
 * falls back to "every id is new" so the user can still confirm.
 */
type ServerDiffState =
  | { readonly _tag: 'loading' }
  | {
      readonly _tag: 'ready'
      readonly comparisons: GroupComparisons
      /**
       * Whether these are the verdicts the batch last settled on, carried
       * over while the changed batch's own load: the confirm waits on it.
       */
      readonly refreshing: boolean
    }
  | {
      readonly _tag: 'error'
      readonly comparisons: GroupComparisons
      readonly error: Error
    }

/** No comparisons, held once so an empty batch keeps a stable identity. */
const NO_COMPARISONS: GroupComparisons = new Map()

/** No verdicts by `Type/id`: what a failed classification settles on, so every id reads as `new`. */
const NO_VERDICTS: ReadonlyMap<string, ServerComparison> = new Map()

/** The comparison a resource with no classifier entry falls back to. */
const AS_NEW: ServerComparison = { status: 'new', fields: [] }

/**
 * Re-key a `Type/id → comparison` map onto the batch's review groups and
 * their resource keys.
 *
 * @param rows - Every previewed resource with its group
 * @param byDiffKey - The classifier's verdicts by `Type/id`
 * @returns The verdicts by group, then by resource key; a row the classifier
 *   did not cover reads as `new`
 */
const byGroupAndKey = (
  rows: readonly DiffRow[],
  byDiffKey: ReadonlyMap<string, ServerComparison>
): GroupComparisons => {
  const comparisons = new Map<ReviewGroup, Map<string, ServerComparison>>()
  for (const row of rows) {
    const group = comparisons.get(row.group) ?? new Map<string, ServerComparison>()
    group.set(row.key, byDiffKey.get(literalReferenceOf(row.resource)) ?? AS_NEW)
    comparisons.set(row.group, group)
  }
  return comparisons
}

/**
 * Every previewed resource across a batch's formats and its linked records,
 * paired with its group and labeled key — the flat list one classifier round
 * trip probes.
 */
const diffRowsOf = (batch: ResolvedBatch): readonly DiffRow[] => [
  ...formatKinds.flatMap((kind) =>
    DecodedFile.resources(batch.formats[kind].decoded).map((entry): DiffRow => ({
      group: kind,
      key: entry.key,
      resource: entry.resource,
    }))
  ),
  ...batch.linkedRecords.map((entry): DiffRow => ({
    group: LINKED_GROUP,
    key: entry.key,
    resource: entry.resource,
  })),
]

/**
 * Run the pre-fetch over every labeled resource across the batch's formats
 * and linked records and expose the classification as a
 * `ReviewGroup → resource key → ServerComparison` lookup.
 *
 * @param batch - The current decoded batch (undefined while the
 *   import-run is still `idle` or `reading`); only read formats contribute
 *   resources
 * @param batchId - Identifies the picked batch: stable across a settings
 *   re-decode or a link choice over the same files, different for a fresh
 *   pick. It is what decides whether the verdicts the batch last settled on
 *   may stay on screen while the next ones load.
 * @returns `loading` until this batch has verdicts worth showing, then `ready`
 */
const useServerDiff = (batch: ResolvedBatch | undefined, batchId: number): ServerDiffState => {
  const runAuthed = useRunAuthed()

  // Every resource across every format, paired with its format and labeled
  // key — one flat list drives one bundle round trip.
  const rows = useMemo(
    (): readonly DiffRow[] | undefined => (batch === undefined ? undefined : diffRowsOf(batch)),
    [batch]
  )

  // A token that advances whenever the decoded batch changes reference — a
  // fresh pick or a settings re-decode. It stands in for `rows` in the query
  // key: naming `rows` there would have TanStack hash every FHIR resource in
  // the batch on every render. Kept in state and adjusted during render off
  // the changed input (the React-sanctioned "derive from a changed prop"
  // pattern) rather than a ref, which must not be read during render.
  const [tracked, setTracked] = useState<{
    readonly rows: readonly DiffRow[] | undefined
    readonly token: number
  }>({ rows, token: 0 })
  let token = tracked.token
  if (tracked.rows !== rows) {
    token += 1
    setTracked({ rows, token })
  }

  const enabled = rows !== undefined && rows.length > 0
  const query = useQuery({
    queryKey: [...IMPORTER_QUERY_KEY, 'server-diff', batchId, token] as const,
    queryFn: (): Promise<ReadonlyMap<string, ServerComparison>> =>
      runAuthed(classifyAgainstServer((rows ?? []).map((row) => row.resource))),
    enabled,
    // A batch's server comparison does not drift under the reviewer, and the
    // batch identity is ephemeral, so never restale and do not retain it.
    staleTime: Infinity,
    gcTime: 0,
    // A failed classification is asked again before it is reported; nothing is
    // asked twice while an answer is in flight.
    retry: 2,
  })

  // The verdicts this batch last settled on — a failed classification settles
  // on none — kept in state and adjusted during render like `tracked`, so a
  // changed batch's panel stays up, on them, while its own are in flight.
  const [lastSettled, setLastSettled] = useState<
    | { readonly batchId: number; readonly verdicts: ReadonlyMap<string, ServerComparison> }
    | undefined
  >(undefined)
  const settledNow = query.data ?? (query.isError ? NO_VERDICTS : undefined)
  if (
    settledNow !== undefined &&
    (lastSettled?.batchId !== batchId || lastSettled.verdicts !== settledNow)
  ) {
    setLastSettled({ batchId, verdicts: settledNow })
  }
  const carriedOver = lastSettled?.batchId === batchId ? lastSettled.verdicts : undefined

  return useMemo((): ServerDiffState => {
    if (!enabled || rows === undefined) {
      return { _tag: 'ready', comparisons: NO_COMPARISONS, refreshing: false }
    }
    if (query.data !== undefined) {
      return { _tag: 'ready', comparisons: byGroupAndKey(rows, query.data), refreshing: false }
    }
    if (query.isError)
      return {
        _tag: 'error',
        comparisons: byGroupAndKey(rows, NO_VERDICTS),
        error:
          query.error instanceof Error
            ? query.error
            : new Error('Failed to check the server for existing copies'),
      }
    if (carriedOver !== undefined) {
      return { _tag: 'ready', comparisons: byGroupAndKey(rows, carriedOver), refreshing: true }
    }
    return { _tag: 'loading' }
  }, [enabled, rows, query.data, query.isError, query.error, carriedOver])
}

/**
 * The keys of `labeled` the server diff found `unchanged`: what the review
 * leaves out by default, so a re-import of resources the server already
 * holds writes nothing unless the reviewer ticks them.
 *
 * @param labeled - The group's labeled resources
 * @param comparisons - The group's own verdicts by resource key (`undefined`
 *   when the diff has none for it, which finds nothing unchanged)
 */
const unchangedKeysOf = (
  labeled: readonly DecodedFile.Resource[],
  comparisons: ReadonlyMap<string, ServerComparison> | undefined
): ReadonlySet<string> =>
  new Set(
    labeled.filter(({ key }) => comparisons?.get(key)?.status === 'unchanged').map(({ key }) => key)
  )

/**
 * The keys of `kind`'s rows of `batch` the review leaves out unless the
 * reviewer ticks them, derived from the batch as it is now: every row the
 * server holds `unchanged` ({@link unchangedKeysOf}), and every row left
 * without a patient as it will be written (`importer-core`'s
 * `keysWithoutPatientOf`), so a link or a pick that gives it one takes it
 * back in.
 *
 * @param batch - The resolved batch
 * @param kind - A format the batch claimed
 * @param comparisons - The format's own verdicts by resource key
 * @param selection - The format's selection, whose edits are asked of
 */
const formatExcludedByDefault = (
  batch: ResolvedBatch,
  kind: FormatKind,
  comparisons: ReadonlyMap<string, ServerComparison> | undefined,
  selection: StagedImport.Selection
): ReadonlySet<string> =>
  new Set([
    ...unchangedKeysOf(DecodedFile.resources(batch.formats[kind].decoded), comparisons),
    ...keysWithoutPatientOf(batch, kind, selection),
  ])

export {
  byGroupAndKey,
  type DiffRow,
  diffRowsOf,
  type GroupComparisons,
  formatExcludedByDefault,
  type ServerDiffState,
  unchangedKeysOf,
  useServerDiff,
}
