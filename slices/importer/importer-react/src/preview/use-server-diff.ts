import { useEffect, useMemo, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import { classifyAgainstServer, diffKey, type DiffStatus } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { type LabeledResource, sectionResources } from 'importer-fundamentals'

import type { FileReadOutcome } from './use-import-run.ts'

/**
 * Pre-fetch the server's copy for every previewed resource in a batch and
 * classify each as `new` / `unchanged` / `changed` — the diff badge the
 * preview row shows the reviewer, and the seed for the "opt out of a
 * re-import" default (an `unchanged` row is pre-excluded in the initial
 * selection).
 *
 * @remarks
 * One `POST /` batch of GET entries fetches every id at once, so a review
 * across two dozen files is still one round trip. The keys the returned map
 * is indexed by are the reviewed {@link LabeledResource.key}s — the same
 * keys the shell already uses everywhere — so a caller looks a status up by
 * the key it already holds, without knowing that under the hood the
 * classifier routes on `resourceType/id`.
 *
 * The hook is a *view* (never fails, never blocks confirming): while the
 * pre-fetch is in flight, or if the whole submission failed, every id maps
 * to `new`, so the shell still shows every row as writable and no
 * auto-exclusion kicks in — the write path still attempts, and a resource
 * the server holds silently is treated as fresh. The classifier itself
 * never fails (a whole-bundle transport error attributes every id to `new`
 * inside `classifyAgainstServer`).
 *
 * @packageDocumentation
 */

/**
 * The state of the pre-fetch: `pending` (in flight, nothing to render yet),
 * `ready` (the classification is complete for this batch of read files —
 * the map may still be empty when the batch had no readable resources at
 * all).
 */
type ServerDiffState =
  | { readonly _tag: 'pending' }
  | { readonly _tag: 'ready'; readonly statuses: ReadonlyMap<string, DiffStatus> }

/**
 * Run the pre-fetch over every labeled resource across the batch's read
 * files and expose the classification as a `LabeledResource.key → DiffStatus`
 * lookup.
 *
 * @param files - The current batch's read outcomes (undefined while the
 *   import-run is still `idle` or `reading`); only `read` files contribute
 *   resources
 * @returns The classification state (`pending` while in flight, `ready`
 *   with the map after)
 */
const useServerDiff = (files: readonly FileReadOutcome[] | undefined): ServerDiffState => {
  const runAuthed = useRunAuthed()

  // Every resource across every read file, paired with its labeled key —
  // one flat list drives one bundle round trip.
  const flat = useMemo(() => {
    if (files === undefined) return undefined
    const rows: { readonly key: string; readonly resource: FhirResource }[] = []
    for (const file of files) {
      if (file._tag !== 'read') continue
      for (const entry of sectionResources(file.decoded.sections)) {
        rows.push({ key: entry.key, resource: entry.resource })
      }
    }
    return rows
  }, [files])

  const [state, setState] = useState<ServerDiffState>(() =>
    flat !== undefined && flat.length === 0
      ? { _tag: 'ready', statuses: new Map() }
      : { _tag: 'pending' }
  )
  // Track the last `flat` we started a classify for so a synchronous state
  // reset happens only when the batch identity changes — a follow-up render
  // where `flat` is unchanged doesn't re-transition to `pending`.
  const lastFlatRef = useRef<typeof flat>(flat)
  if (lastFlatRef.current !== flat) {
    lastFlatRef.current = flat
    if (flat === undefined || flat.length > 0) setState({ _tag: 'pending' })
    else setState({ _tag: 'ready', statuses: new Map() })
  }

  useEffect(() => {
    if (flat === undefined || flat.length === 0) return (): void => undefined
    let cancelled = false
    const resources = flat.map((row) => row.resource)
    const settle = (byDiffKey: ReadonlyMap<string, DiffStatus>): void => {
      if (cancelled) return
      const statuses = new Map<string, DiffStatus>()
      for (const row of flat) {
        statuses.set(row.key, byDiffKey.get(diffKey(row.resource)) ?? 'new')
      }
      setState({ _tag: 'ready', statuses })
    }
    void runAuthed(classifyAgainstServer(resources)).then(
      settle,
      // classifyAgainstServer's error channel is `never`; `runAuthed` can
      // still reject on an unhandled defect from the auth path itself. Fall
      // back to "every id is new" so the shell renders the batch as
      // writable instead of stalling on `pending`.
      () => settle(new Map())
    )

    return (): void => {
      cancelled = true
    }
  }, [flat, runAuthed])

  return state
}

/**
 * The `Review.Selection.excludedResources` set for a file, seeded from the
 * server diff: every `unchanged` labeled resource is pre-excluded so a
 * re-import of a file whose resources the server already holds writes
 * nothing by default. The reviewer can still tick any row back on.
 */
const initialExclusionsFor = (
  labeled: readonly LabeledResource<FhirResource>[],
  statuses: ReadonlyMap<string, DiffStatus>
): ReadonlySet<string> => {
  const excluded = new Set<string>()
  for (const entry of labeled) {
    if (statuses.get(entry.key) === 'unchanged') excluded.add(entry.key)
  }
  return excluded
}

export { initialExclusionsFor, useServerDiff, type ServerDiffState }
