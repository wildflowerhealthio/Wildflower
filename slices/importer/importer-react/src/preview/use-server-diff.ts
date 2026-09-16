import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import { classifyAgainstServer, diffKey, type ServerComparison } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { type LabeledResource, sectionResources } from 'importer-fundamentals'

import { IMPORTER_QUERY_KEY } from '../queries/keys.ts'
import type { FileReadOutcome } from './use-import-run.ts'

/**
 * Pre-fetch the server's copy for every previewed resource in a batch and
 * classify each as `new` / `unchanged` / `changed` — the diff badge the
 * preview row shows the reviewer, and the seed for the "opt out of a
 * re-import" default (an `unchanged` row is pre-excluded in the initial
 * selection).
 *
 * @remarks
 * The classification is a TanStack Query, so the shell can **block on its
 * first load** (`firstLoad` gates the preview) rather than paint the panel
 * first and let badges pop in a second later. One `POST /` batch of GET entries
 * fetches every id at once, so a review across two dozen files is still one
 * round trip. The returned map is indexed by the reviewed
 * {@link LabeledResource.key}s — the same keys the shell already uses
 * everywhere — so a caller looks a status up by the key it already holds,
 * without knowing the classifier routes on `resourceType/id` underneath.
 *
 * The hook never fails and never blocks *confirming*: the classifier's own
 * error channel is `never` (a whole-bundle transport error attributes every
 * id to `new` inside `classifyAgainstServer`), and if `runAuthed` itself
 * rejects on an auth defect the query error is folded to "every id is new" so
 * the shell still resolves to a writable batch instead of stalling.
 *
 * @packageDocumentation
 */

/** One labeled resource paired with the value the classifier probes for it. */
interface DiffRow {
  readonly key: string
  readonly resource: FhirResource
}

/**
 * The state of the pre-fetch.
 *
 * @remarks
 * `firstLoad` is the shell's paint gate, and it is deliberately narrower than
 * "a classification is in flight": a settings change re-decodes, which starts
 * a *second* classification, and gating the preview on that one would unmount
 * the whole panel — taking the focused settings input with it — on every change the
 * reviewer makes. So only the first classification of a batch blocks; a later
 * one resolves underneath the painted panel, with `comparisons` still holding
 * the previous classification meanwhile so badges refresh in place rather than
 * blinking out. Resource keys are stable across a re-decode, so the retained
 * map stays addressable by the same keys throughout.
 */
interface ServerDiffState {
  /**
   * The classification in hand, keyed by {@link LabeledResource.key}. While a
   * re-classification is in flight this is the previous one; it is empty only
   * before anything has ever resolved, or when the batch had no resources.
   */
  readonly comparisons: ReadonlyMap<string, ServerComparison>
  /** Whether no classification has resolved yet for this batch of files. */
  readonly firstLoad: boolean
}

/** The empty map, held once so an unresolved state keeps a stable identity. */
const EMPTY_COMPARISONS: ReadonlyMap<string, ServerComparison> = new Map()

/** The comparison a resource with no classifier entry falls back to. */
const AS_NEW: ServerComparison = { status: 'new', fields: [] }

/** Re-key a `Type/id → comparison` map onto the batch's `LabeledResource.key`s. */
const byLabeledKey = (
  rows: readonly DiffRow[],
  byDiffKey: ReadonlyMap<string, ServerComparison>
): ReadonlyMap<string, ServerComparison> => {
  const comparisons = new Map<string, ServerComparison>()
  for (const row of rows) comparisons.set(row.key, byDiffKey.get(diffKey(row.resource)) ?? AS_NEW)
  return comparisons
}

/**
 * Run the pre-fetch over every labeled resource across the batch's read
 * files and expose the classification as a `LabeledResource.key →
 * ServerComparison` lookup.
 *
 * @param files - The current batch's read outcomes (undefined while the
 *   import-run is still `idle` or `reading`); only `read` files contribute
 *   resources
 * @returns The classification state: the comparisons in hand, and whether none
 *   has resolved yet for this batch
 */
const useServerDiff = (files: readonly FileReadOutcome[] | undefined): ServerDiffState => {
  const runAuthed = useRunAuthed()

  // Every resource across every read file, paired with its labeled key —
  // one flat list drives one bundle round trip.
  const rows = useMemo((): readonly DiffRow[] | undefined => {
    if (files === undefined) return undefined
    const collected: DiffRow[] = []
    for (const file of files) {
      if (file._tag !== 'read') continue
      for (const entry of sectionResources(file.decoded.sections)) {
        collected.push({ key: entry.key, resource: entry.resource })
      }
    }
    return collected
  }, [files])

  // A token that advances whenever the decoded batch changes reference — a
  // fresh pick or a settings re-decode. It is the query's identity: two
  // renders with the same `rows` share one fetch, a re-decode starts a new
  // one. Kept in state and adjusted during render off the changed input (the
  // React-sanctioned "derive from a changed prop" pattern) rather than a ref,
  // which must not be read during render.
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
    queryKey: [...IMPORTER_QUERY_KEY, 'server-diff', token] as const,
    queryFn: (): Promise<ReadonlyMap<string, ServerComparison>> =>
      runAuthed(classifyAgainstServer((rows ?? []).map((row) => row.resource))),
    enabled,
    // A batch's server comparison does not drift under the reviewer, and the
    // batch identity is ephemeral, so never restale and do not retain it.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })

  // The classification for the *current* rows, or undefined while it is in
  // flight. An auth-path rejection folds to "every id is new" rather than
  // stall the preview forever on a loader.
  const resolved = useMemo((): ReadonlyMap<string, ServerComparison> | undefined => {
    if (!enabled || rows === undefined) return new Map()
    if (query.isSuccess) return byLabeledKey(rows, query.data)
    if (query.isError) return byLabeledKey(rows, new Map())
    return undefined
  }, [enabled, rows, query.isSuccess, query.isError, query.data])

  // Hold the latest resolved classification so a re-decode's in-flight query
  // shows the previous badges instead of none, paired with whether a batch was
  // present when it was taken. Crossing that boundary (the run goes idle or
  // `reading` between picks) drops the map, so the *next* batch blocks on its
  // own first classification instead of painting the last one's badges.
  // Adjusted during render off the changed input, the same
  // derive-from-a-changed-value pattern `tracked` uses.
  const hasBatch = rows !== undefined
  const [retained, setRetained] = useState<{
    readonly hasBatch: boolean
    readonly comparisons: ReadonlyMap<string, ServerComparison> | undefined
  }>({ hasBatch, comparisons: undefined })
  if (retained.hasBatch !== hasBatch) setRetained({ hasBatch, comparisons: undefined })
  else if (resolved !== undefined && retained.comparisons !== resolved) {
    setRetained({ hasBatch, comparisons: resolved })
  }

  return useMemo((): ServerDiffState => {
    const previous = retained.hasBatch === hasBatch ? retained.comparisons : undefined
    return {
      comparisons: resolved ?? previous ?? EMPTY_COMPARISONS,
      firstLoad: resolved === undefined && previous === undefined,
    }
  }, [resolved, retained, hasBatch])
}

/**
 * The `StagedImport.Selection.excludedResources` set for a file, seeded from the
 * server diff: every `unchanged` labeled resource is pre-excluded so a
 * re-import of a file whose resources the server already holds writes
 * nothing by default. The reviewer can still tick any row back on.
 */
const initialExclusionsFor = (
  labeled: readonly LabeledResource<FhirResource>[],
  comparisons: ReadonlyMap<string, ServerComparison>
): ReadonlySet<string> => {
  const excluded = new Set<string>()
  for (const entry of labeled) {
    if (comparisons.get(entry.key)?.status === 'unchanged') excluded.add(entry.key)
  }
  return excluded
}

export { initialExclusionsFor, useServerDiff, type ServerDiffState }
