import { Effect } from 'effect'
import { useRunAuthed } from 'fhir-r4-react'
import { type BatchEntryOutcome, persistBatchBundle } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { useCallback, useRef, useState } from 'react'
import { DataSet, WriteOrder } from 'synthetic-data-core'

import { fetchedFileSource } from './data-set-files.ts'

/**
 * The load: read every chosen file back into the resource the import wrote,
 * and only when every one reads, write them to the connected FHIR server.
 *
 * @remarks
 * Reading comes first and finishes whole. A file that cannot be fetched, that
 * holds another resource than its path names, or whose source file is not the
 * bytes its attachment describes stops the load before anything is written,
 * so a load never leaves half a record set on the server over a bad file.
 *
 * The write is `WriteOrder.bundlesOf`'s bundles, one `persistBatchBundle`
 * after another, so every resource is stored after the resources it
 * references. A bundle's error channel is `never`: a rejected entry is an
 * outcome like any other, and the next bundle still goes.
 *
 * @packageDocumentation
 */

/** How many files are fetched at once. */
const READ_CONCURRENCY = 8

/** Where a load is. */
type LoadState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'reading'; readonly read: number; readonly total: number }
  | { readonly _tag: 'writing'; readonly written: number; readonly total: number }
  /** Some files did not read; nothing was written. */
  | { readonly _tag: 'unreadable'; readonly failures: readonly DataSet.UnreadableFile[] }
  /** Every bundle was submitted; one outcome per resource, in write order. */
  | { readonly _tag: 'done'; readonly outcomes: readonly BatchEntryOutcome[] }
  /** The load stopped on something other than a file or an entry: a defect. */
  | { readonly _tag: 'failed'; readonly error: unknown }

/** What the screen drives a load through. */
interface DataSetLoad {
  readonly state: LoadState
  /** Load the resource files at `resourcePaths` of the data set at `root`. */
  readonly load: (root: URL, resourcePaths: readonly string[]) => void
  /** Back to `idle`, dropping a load still running. */
  readonly reset: () => void
}

/** Whether a load is running, so the form that starts one is locked. */
const isLoadRunning = (state: LoadState): boolean =>
  state._tag === 'reading' || state._tag === 'writing'

/**
 * Drive loads of a data set into the FHIR server the route context's authed
 * runner writes to (`fhir-r4-react`'s `useRunAuthed`). Mount under the host
 * app's router.
 */
const useDataSetLoad = (): DataSetLoad => {
  const runAuthed = useRunAuthed()
  const [state, setState] = useState<LoadState>({ _tag: 'idle' })
  // The load a state update belongs to: a reset or a newer load makes an
  // older one's updates stale.
  const latest = useRef(0)

  const load = useCallback(
    (root: URL, resourcePaths: readonly string[]): void => {
      latest.current += 1
      const ticket = latest.current
      const update = (next: LoadState): void => {
        if (latest.current === ticket) setState(next)
      }
      const source = fetchedFileSource(root)
      const total = resourcePaths.length
      let read = 0
      update({ _tag: 'reading', read, total })

      const readEvery = Effect.partition(
        resourcePaths,
        (path) =>
          DataSet.readResource(source, path).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                read += 1
                update({ _tag: 'reading', read, total })
              })
            )
          ),
        { concurrency: READ_CONCURRENCY }
      )

      const writeEvery = (resources: readonly FhirResource[]): Promise<void> => {
        const outcomes: BatchEntryOutcome[] = []
        update({ _tag: 'writing', written: 0, total })
        const writeBundles = Effect.forEach(
          WriteOrder.bundlesOf(resources),
          (bundle) =>
            persistBatchBundle(bundle).pipe(
              Effect.tap((entries) =>
                Effect.sync(() => {
                  outcomes.push(...entries)
                  update({ _tag: 'writing', written: outcomes.length, total })
                })
              )
            ),
          { discard: true }
        )
        return runAuthed(writeBundles).then(() => {
          update({ _tag: 'done', outcomes })
        })
      }

      void Effect.runPromise(readEvery)
        .then(([failures, resources]) => {
          if (failures.length > 0) {
            update({ _tag: 'unreadable', failures })
            return undefined
          }
          return latest.current === ticket ? writeEvery(resources) : undefined
        })
        .catch((error: unknown) => {
          update({ _tag: 'failed', error })
        })
    },
    [runAuthed]
  )

  const reset = useCallback((): void => {
    latest.current += 1
    setState({ _tag: 'idle' })
  }, [])

  return { state, load, reset }
}

export { type DataSetLoad, isLoadRunning, type LoadState, useDataSetLoad }
