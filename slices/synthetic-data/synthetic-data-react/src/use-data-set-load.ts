import { Effect, Either } from 'effect'
import { useRunAuthed } from 'fhir-r4-react'
import {
  type BatchEntryOutcome,
  type FhirR4ResourcesHttpApiClient,
  persistBatchBundle,
} from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { unknownErrorToString, unwrapFiberFailure } from 'kitchen-sink'
import { useCallback, useRef, useState } from 'react'

import { type Fetch, readResources } from './data-set-read.ts'
import { writeBatchesOf } from './load-plan.ts'

/**
 * Loading picked people into the FHIR server, as one imperative action: read
 * every one of their files, then write the resources in batch bundles.
 *
 * @remarks
 * Nothing is written until every file has been read, so a file that cannot
 * be read stops the load before it writes part of a person's records. Once
 * writing starts, each bundle is one `persistBatchBundle`, whose error
 * channel is `never`: an entry the server rejects is a per-entry result, and
 * one failed bundle never stops the rest — the same best-effort shape as the
 * importer's confirm (`importer-react`'s `useConfirmImport`). The bundles go
 * one after another, in `writeBatchesOf`'s order, so a resource's references
 * are written before it.
 *
 * The authed runner comes from router context (`fhir-r4-react`'s
 * `useRunAuthed`), so mount this under the host app's router.
 */

/** Where a load is. */
type DataSetLoad =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'reading'; readonly filesRead: number; readonly fileCount: number }
  | {
      readonly _tag: 'writing'
      readonly resourcesSubmitted: number
      readonly resourceCount: number
    }
  /** Every bundle has been answered; `outcomes` has one entry per resource, in write order. */
  | { readonly _tag: 'loaded'; readonly outcomes: readonly BatchEntryOutcome[] }
  /** A file could not be read (nothing was written), or the load itself died. */
  | { readonly _tag: 'failed'; readonly reason: string }

/** The surface a screen drives a load through. */
interface DataSetLoader {
  readonly load: DataSetLoad
  /** Read the files at `resourcePaths` under `root`, then write what they hold. */
  readonly start: (root: URL, resourcePaths: readonly string[]) => void
  /** Forget the load and return to `idle`; a load still running is ignored when it ends. */
  readonly reset: () => void
}

/**
 * Write `resources` in `writeBatchesOf`'s bundles, one after another.
 *
 * @param onBundleAnswered - Called with each bundle's size once the server answers it
 * @returns Every resource's outcome, in write order
 */
const writeResources = (
  resources: readonly FhirResource[],
  onBundleAnswered: (bundleSize: number) => void
): Effect.Effect<readonly BatchEntryOutcome[], never, FhirR4ResourcesHttpApiClient> =>
  Effect.forEach(writeBatchesOf(resources), (bundle) =>
    persistBatchBundle(bundle).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          onBundleAnswered(bundle.length)
        })
      )
    )
  ).pipe(Effect.map((outcomes) => outcomes.flat()))

/**
 * Drives one load at a time through `runAuthed`, publishing its progress.
 *
 * @param fetchUrl - How the data set's files are fetched
 * @returns The load's state, and `start` / `reset`
 */
const useDataSetLoad = (fetchUrl: Fetch): DataSetLoader => {
  const runAuthed = useRunAuthed()
  const [load, setLoad] = useState<DataSetLoad>({ _tag: 'idle' })
  const latest = useRef(0)

  const start = useCallback(
    (root: URL, resourcePaths: readonly string[]): void => {
      latest.current += 1
      const ticket = latest.current
      const publish = (next: DataSetLoad): void => {
        if (latest.current === ticket) setLoad(next)
      }
      const fileCount = resourcePaths.length
      let filesRead = 0
      publish({ _tag: 'reading', filesRead, fileCount })

      const readAll = readResources(root, resourcePaths, fetchUrl, () => {
        filesRead += 1
        publish({ _tag: 'reading', filesRead, fileCount })
      })
      const program = readAll.pipe(
        Effect.flatMap((resources) => {
          const resourceCount = resources.length
          let resourcesSubmitted = 0
          publish({ _tag: 'writing', resourcesSubmitted, resourceCount })
          return writeResources(resources, (bundleSize) => {
            resourcesSubmitted += bundleSize
            publish({ _tag: 'writing', resourcesSubmitted, resourceCount })
          })
        })
      )

      runAuthed(Effect.either(program)).then(
        (result) => {
          publish(
            Either.match(result, {
              onLeft: (error): DataSetLoad => ({ _tag: 'failed', reason: error.message }),
              onRight: (outcomes): DataSetLoad => ({ _tag: 'loaded', outcomes }),
            })
          )
        },
        (defect: unknown) => {
          publish({ _tag: 'failed', reason: unknownErrorToString(unwrapFiberFailure(defect)) })
        }
      )
    },
    [runAuthed, fetchUrl]
  )

  const reset = useCallback((): void => {
    latest.current += 1
    setLoad({ _tag: 'idle' })
  }, [])

  return { load, start, reset }
}

export { useDataSetLoad }
export type { DataSetLoad, DataSetLoader }
