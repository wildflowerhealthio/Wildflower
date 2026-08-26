import { Effect, type ParseResult } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import { HarImport, type ImportPreview } from 'importer-core'

import type { PickedHar } from '../sources/picked-har.ts'

/**
 * Running the read half of the import — `importer-core`'s `HarImport.run` — over a
 * batch of {@link PickedHar}s, and holding each one's {@link ImportPreview} for
 * the screen to show combined.
 *
 * @remarks
 * This is the pure, non-writing side of the flow: `HarImport.run` decodes an
 * archive, detects the importer, runs its entities, and folds the
 * result, requiring no services and writing nothing. Each pick is read
 * independently — files in a batch may be recognized by different importers, or
 * not at all — and the outcomes are held side by side as {@link ReadEntry}s so
 * the preview can sum them. It is run through `fhir-r4-react`'s `useRunAuthed` —
 * the one runner every source in this slice already reads from router context —
 * even though a preview needs no auth, so the whole slice drives one runner
 * rather than reaching for `Effect.runPromise` here. The write client stays
 * unreachable from a preview by `HarImport.run`'s own construction, not by
 * anything this hook does.
 *
 * A malformed archive is the only failure `HarImport.run` has, surfaced per file
 * as an `unreadable` entry rather than a whole-batch error — a local pick was
 * validated through the HAR parser at the picker so it rarely fires, but a server
 * archive is decoded, not re-validated, so the case exists for it and, in a
 * batch, one bad file does not sink the others.
 *
 * @packageDocumentation
 */

/**
 * One pick's read outcome, held alongside the pick so a confirm can hand both to
 * the write step.
 *
 * @remarks
 * `read` carries the whole {@link ImportPreview.ImportPreview} union — a `NoSourceClaims` is
 * a first-class outcome the preview view renders, not an error — and `unreadable`
 * carries the one malformed-archive `ParseError`. The confirm step writes only
 * the `read` entries whose preview is a claimed `Preview` with resources. `id` is
 * a per-pick stable identity for a React `key`, since two files in a batch can
 * share a name.
 */
type ReadEntry =
  | {
      readonly _tag: 'read'
      readonly id: string
      readonly picked: PickedHar
      readonly preview: ImportPreview.ImportPreview
    }
  | {
      readonly _tag: 'unreadable'
      readonly id: string
      readonly picked: PickedHar
      readonly error: ParseResult.ParseError
    }

/**
 * The lifecycle of one batch read, holding every pick's outcome so the screen can
 * render one combined preview.
 */
type ImportRunState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'reading' }
  | { readonly _tag: 'ready'; readonly entries: readonly ReadEntry[] }

/** Imperative surface the screen drives the read through. */
interface ImportRun {
  readonly state: ImportRunState
  /** Read a freshly-picked batch of HARs into previews, replacing any previous one. */
  readonly run: (picks: readonly PickedHar[]) => void
  /** Discard the current read and return to `idle`. */
  readonly reset: () => void
}

/**
 * Drives a batch read as an imperative action, mapping each pick's
 * `HarImport.run` outcome onto a {@link ReadEntry}. The authed runner comes from
 * router context via `fhir-r4-react`, so mount this inside the host app's router.
 *
 * @returns The read surface: its `state`, the `run` trigger, and a `reset` back
 *   to `idle`
 */
const useImportRun = (): ImportRun => {
  const runAuthed = useRunAuthed()
  const [state, setState] = useState<ImportRunState>({ _tag: 'idle' })
  // A re-pick while a read is in flight must win — track the latest ticket so a
  // stale resolution is dropped rather than clobbering the newer preview.
  const latest = useRef(0)

  const run = useCallback(
    (picks: readonly PickedHar[]): void => {
      if (picks.length === 0) return
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'reading' })
      // Each pick reads independently and concurrently; `catchAll` turns the sole
      // `ParseError` into an `unreadable` entry, so one bad file in the batch is a
      // row rather than a whole-batch failure — the read Effect cannot fail.
      const readAll = Effect.forEach(
        picks,
        (picked) =>
          Effect.gen(function* () {
            const id = yield* Effect.sync(() => crypto.randomUUID())
            return yield* HarImport.run(picked.text).pipe(
              Effect.map((preview): ReadEntry => ({ _tag: 'read', id, picked, preview })),
              Effect.catchAll((error) =>
                Effect.succeed<ReadEntry>({ _tag: 'unreadable', id, picked, error })
              )
            )
          }),
        { concurrency: 'unbounded' }
      )
      void runAuthed(readAll).then((entries) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'ready', entries })
      })
    },
    [runAuthed]
  )

  const reset = useCallback((): void => {
    latest.current++
    setState({ _tag: 'idle' })
  }, [])

  return { state, run, reset }
}

export { type ImportRun, type ImportRunState, type ReadEntry, useImportRun }
