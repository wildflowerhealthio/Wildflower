import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import { classifyAgainstServer, diffKey, type ServerComparison } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { DecodedFile } from 'importer-fundamentals'

import type { BatchDecodeResult, FormatKind } from 'importer-core'
import { formatKinds } from 'importer-core'
import { IMPORTER_QUERY_KEY } from '../queries/keys.ts'

/**
 * Pre-fetch the server's copy for every previewed resource in a batch and
 * classify each as `new` / `unchanged` / `changed` — the diff badge the
 * preview row shows the reviewer, and the seed for the "opt out of a
 * re-import" default (an `unchanged` row is pre-excluded in the initial
 * selection).
 *
 * @remarks
 * The classification is a TanStack Query, so the shell can **block on it**
 * (the `loading` state gates the preview) rather than paint the panel first
 * and let badges pop in a second later. One `POST /` batch of GET entries
 * fetches every id at once, so a review across two dozen files is still one
 * round trip.
 *
 * `loading` means "nothing worth showing yet", which is narrower than "a
 * request is in flight". A settings change re-decodes, which starts a *second*
 * classification for the same batch, and reporting `loading` for that one
 * would unmount the whole preview — taking the focus of whatever settings
 * control the reviewer is using with it. So a re-classification keeps the
 * previous one on screen (`placeholderData`, scoped to the batch it came
 * from) and swaps in the new verdicts when they land. A *fresh pick* is a new
 * batch and gets no such carry-over: its badges would be about the last
 * batch's files.
 *
 * The hook never blocks *confirming*: the classifier's own error channel is
 * `never` (a whole-bundle transport error attributes every id to `new` inside
 * `classifyAgainstServer`), and if `runAuthed` itself rejects on an auth
 * defect the query error surfaces as an `error` state whose `comparisons`
 * fall back to "every id is new" so the shell still resolves to a writable
 * batch rather than stalling — but the error is visible in the UI.
 *
 * @packageDocumentation
 */

/** One labeled resource, the format it belongs to, and the value the classifier probes for it. */
interface DiffRow {
  readonly format: FormatKind
  readonly key: string
  readonly resource: FhirResource
}

/**
 * Every previewed resource's server comparison, keyed by format kind and
 * then by {@link LabeledResource.key} within the format.
 *
 * @remarks
 * Two formats can carry the same resource key — a format whose keys name
 * the resource's role (DICOM's `patient`, `imaging-study`) repeats them per
 * file, and every format's source-file row is keyed by file name — so a
 * flat map keyed by resource key alone would let one format's verdict
 * overwrite another's. Scoping by format keeps each format's badges and
 * pre-exclusions its own.
 */
type FormatComparisons = ReadonlyMap<FormatKind, ReadonlyMap<string, ServerComparison>>

/**
 * The state of the pre-fetch: `loading` while there is nothing worth showing
 * for this batch (the shell paints a loader instead of the preview), `ready`
 * once there is — the verdicts for this batch, or the ones carried over from
 * the same batch's previous classification while a re-decode's is in flight,
 * `error` when the auth-path or network request failed — the shell shows an
 * error and falls back to "every id is new" so the user can still confirm.
 */
type ServerDiffState =
  | { readonly _tag: 'loading' }
  | { readonly _tag: 'ready'; readonly comparisons: FormatComparisons }
  | {
      readonly _tag: 'error'
      readonly comparisons: FormatComparisons
      readonly error: Error
    }

/** No comparisons, held once so an empty batch keeps a stable identity. */
const NO_COMPARISONS: FormatComparisons = new Map()

/** The comparison a resource with no classifier entry falls back to. */
const AS_NEW: ServerComparison = { status: 'new', fields: [] }

/**
 * Re-key a `Type/id → comparison` map onto the batch's formats and their
 * `LabeledResource.key`s.
 *
 * @param rows - Every previewed resource with its format
 * @param byDiffKey - The classifier's verdicts by `Type/id`
 * @returns The verdicts by format kind, then by resource key; a row the
 *   classifier did not cover reads as `new`
 */
const byFormatAndKey = (
  rows: readonly DiffRow[],
  byDiffKey: ReadonlyMap<string, ServerComparison>
): FormatComparisons => {
  const comparisons = new Map<FormatKind, Map<string, ServerComparison>>()
  for (const row of rows) {
    const format = comparisons.get(row.format) ?? new Map<string, ServerComparison>()
    format.set(row.key, byDiffKey.get(diffKey(row.resource)) ?? AS_NEW)
    comparisons.set(row.format, format)
  }
  return comparisons
}

/**
 * Every previewed resource across a batch's formats, paired with its format
 * and labeled key — the flat list one classifier round trip probes.
 */
const diffRowsOf = (batch: BatchDecodeResult): readonly DiffRow[] =>
  formatKinds.flatMap((kind) =>
    DecodedFile.resources(batch[kind].decoded).map((entry): DiffRow => ({
      format: kind,
      key: entry.key,
      resource: entry.resource,
    }))
  )

/**
 * The batch id carried second-from-last in this hook's query keys — read back
 * off a *previous* query to decide whether its verdicts may carry over.
 * Positional from the end so the key's prefix can grow without breaking it.
 */
const batchOf = (queryKey: readonly unknown[]): number | undefined => {
  const value = queryKey.at(-2)
  return typeof value === 'number' ? value : undefined
}

/**
 * Run the pre-fetch over every labeled resource across the batch's formats
 * and expose the classification as a
 * `FormatKind → LabeledResource.key → ServerComparison` lookup.
 *
 * @param batch - The current batch's decode result (undefined while the
 *   import-run is still `idle` or `reading`); only read formats contribute
 *   resources
 * @param batchId - Identifies the picked batch: stable across a settings
 *   re-decode of the same files, different for a fresh pick. It is what
 *   decides whether a previous classification may stay on screen while the
 *   next one loads.
 * @returns `loading` until this batch has verdicts worth showing, then `ready`
 */
const useServerDiff = (batch: BatchDecodeResult | undefined, batchId: number): ServerDiffState => {
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
    // Keep the previous classification on screen while the next one loads, but
    // only within one batch — another batch's verdicts are about other files.
    placeholderData: (previous, previousQuery) =>
      previousQuery !== undefined && batchOf(previousQuery.queryKey) === batchId
        ? previous
        : undefined,
    // A batch's server comparison does not drift under the reviewer, and the
    // batch identity is ephemeral, so never restale and do not retain it.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })

  return useMemo((): ServerDiffState => {
    if (!enabled || rows === undefined) return { _tag: 'ready', comparisons: NO_COMPARISONS }
    if (query.data !== undefined) {
      return { _tag: 'ready', comparisons: byFormatAndKey(rows, query.data) }
    }
    if (query.isError)
      return {
        _tag: 'error',
        comparisons: byFormatAndKey(rows, new Map()),
        error:
          query.error instanceof Error
            ? query.error
            : new Error('Failed to check the server for existing copies'),
      }
    return { _tag: 'loading' }
  }, [enabled, rows, query.data, query.isError, query.error])
}

/**
 * The `StagedImport.Selection.excludedResources` set for a format, seeded
 * from its server diff: every `unchanged` labeled resource is pre-excluded
 * so a re-import of a format whose resources the server already holds writes
 * nothing by default. The reviewer can still tick any row back on.
 *
 * @param labeled - The format's labeled resources
 * @param comparisons - The format's own verdicts by resource key (`undefined`
 *   when the diff has none for it, which excludes nothing)
 * @returns The keys to pre-exclude
 */
const initialExclusionsFor = (
  labeled: readonly DecodedFile.Resource<FhirResource>[],
  comparisons: ReadonlyMap<string, ServerComparison> | undefined
): ReadonlySet<string> => {
  const excluded = new Set<string>()
  for (const entry of labeled) {
    if (comparisons?.get(entry.key)?.status === 'unchanged') excluded.add(entry.key)
  }
  return excluded
}

export {
  byFormatAndKey,
  type DiffRow,
  diffRowsOf,
  type FormatComparisons,
  initialExclusionsFor,
  type ServerDiffState,
  useServerDiff,
}
