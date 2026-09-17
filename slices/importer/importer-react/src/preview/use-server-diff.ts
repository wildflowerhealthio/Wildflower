import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import { classifyAgainstServer, diffKey, type ServerComparison } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { type LabeledResource, sectionResources } from 'importer-fundamentals'

import { Either, Option, pipe } from 'effect'
import type { BatchEntry } from 'importer-core'
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

/** One labeled resource, the unit it belongs to, and the value the classifier probes for it. */
interface DiffRow {
  readonly unitId: string
  readonly key: string
  readonly resource: FhirResource
}

/**
 * Every previewed resource's server comparison, keyed by unit id and then by
 * {@link LabeledResource.key} within the unit.
 *
 * @remarks
 * Two units can carry the same resource key — a format whose keys name the
 * resource's role (DICOM's `patient`, `imaging-study`) repeats them per file,
 * and every format's source-file row is keyed by file name — so a flat map
 * keyed by resource key alone would let one unit's verdict overwrite
 * another's. Scoping by unit keeps each unit's badges and pre-exclusions its
 * own.
 */
type UnitComparisons = ReadonlyMap<string, ReadonlyMap<string, ServerComparison>>

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
  | { readonly _tag: 'ready'; readonly comparisons: UnitComparisons }
  | {
      readonly _tag: 'error'
      readonly comparisons: UnitComparisons
      readonly error: Error
    }

/** No comparisons, held once so an empty batch keeps a stable identity. */
const NO_COMPARISONS: UnitComparisons = new Map()

/** The comparison a resource with no classifier entry falls back to. */
const AS_NEW: ServerComparison = { status: 'new', fields: [] }

/**
 * Re-key a `Type/id → comparison` map onto the batch's units and their
 * `LabeledResource.key`s.
 *
 * @param rows - Every previewed resource with its unit
 * @param byDiffKey - The classifier's verdicts by `Type/id`
 * @returns The verdicts by unit id, then by resource key; a row the
 *   classifier did not cover reads as `new`
 */
const byUnitAndKey = (
  rows: readonly DiffRow[],
  byDiffKey: ReadonlyMap<string, ServerComparison>
): UnitComparisons => {
  const comparisons = new Map<string, Map<string, ServerComparison>>()
  for (const row of rows) {
    const unit = comparisons.get(row.unitId) ?? new Map<string, ServerComparison>()
    unit.set(row.key, byDiffKey.get(diffKey(row.resource)) ?? AS_NEW)
    comparisons.set(row.unitId, unit)
  }
  return comparisons
}

/**
 * Every previewed resource across a batch's read units, paired with its unit
 * and labeled key — the flat list one classifier round trip probes.
 */
const diffRowsOf = (units: readonly BatchEntry[]): readonly DiffRow[] =>
  units.flatMap((unit) =>
    pipe(
      unit,
      Either.getRight,
      Option.map((value) =>
        sectionResources(value.decoded.sections).map((entry): DiffRow => ({
          unitId: value.id,
          key: entry.key,
          resource: entry.resource,
        }))
      ),
      Option.getOrElse(() => [] as const)
    )
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
 * Run the pre-fetch over every labeled resource across the batch's read files
 * and expose the classification as a `LabeledResource.key → ServerComparison`
 * lookup.
 *
 * @param units - The current batch's read outcomes (undefined while the
 *   import-run is still `idle` or `reading`); only `read` units contribute
 *   resources
 * @param batchId - Identifies the picked batch: stable across a settings
 *   re-decode of the same files, different for a fresh pick. It is what
 *   decides whether a previous classification may stay on screen while the
 *   next one loads.
 * @returns `loading` until this batch has verdicts worth showing, then `ready`
 */
const useServerDiff = (
  units: readonly BatchEntry[] | undefined,
  batchId: number
): ServerDiffState => {
  const runAuthed = useRunAuthed()

  // Every resource across every read unit, paired with its unit and labeled
  // key — one flat list drives one bundle round trip.
  const rows = useMemo(
    (): readonly DiffRow[] | undefined => (units === undefined ? undefined : diffRowsOf(units)),
    [units]
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
      return { _tag: 'ready', comparisons: byUnitAndKey(rows, query.data) }
    }
    if (query.isError)
      return {
        _tag: 'error',
        comparisons: byUnitAndKey(rows, new Map()),
        error:
          query.error instanceof Error
            ? query.error
            : new Error('Failed to check the server for existing copies'),
      }
    return { _tag: 'loading' }
  }, [enabled, rows, query.data, query.isError, query.error])
}

/**
 * The `StagedImport.Selection.excludedResources` set for a unit, seeded from
 * its server diff: every `unchanged` labeled resource is pre-excluded so a
 * re-import of a unit whose resources the server already holds writes
 * nothing by default. The reviewer can still tick any row back on.
 *
 * @param labeled - The unit's labeled resources
 * @param comparisons - The unit's own verdicts by resource key (`undefined`
 *   when the diff has none for it, which excludes nothing)
 * @returns The keys to pre-exclude
 */
const initialExclusionsFor = (
  labeled: readonly LabeledResource<FhirResource>[],
  comparisons: ReadonlyMap<string, ServerComparison> | undefined
): ReadonlySet<string> => {
  const excluded = new Set<string>()
  for (const entry of labeled) {
    if (comparisons?.get(entry.key)?.status === 'unchanged') excluded.add(entry.key)
  }
  return excluded
}

export {
  byUnitAndKey,
  type DiffRow,
  diffRowsOf,
  initialExclusionsFor,
  type ServerDiffState,
  type UnitComparisons,
  useServerDiff,
}
