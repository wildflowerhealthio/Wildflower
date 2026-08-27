import { Effect, type ParseResult } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import type { Extraction } from 'http-extraction-fundamentals'
import type { FileImporterDescriptor } from 'importer-fundamentals'

import type { PickedHar } from '../sources/picked-har.ts'

/**
 * Running the read half of the import — the format descriptor's `decode` — over a
 * batch of {@link PickedHar}s, and holding each one's decoded responses for the
 * screen to review.
 *
 * @remarks
 * The pure, non-writing side of the flow: each pick decodes independently into
 * a {@link FileReadOutcome}, a malformed file becoming its own `unreadable` row
 * rather than a whole-batch error. Run through `useRunAuthed` (the slice's one
 * runner) even though a decode needs no auth; the write client stays
 * unreachable by `decode`'s own construction, not by anything this hook does.
 *
 * @packageDocumentation
 */

/**
 * One pick's read outcome, held alongside the pick so a confirm can hand both to
 * the write step.
 *
 * @remarks
 * `read` carries the decoded {@link Extraction.Input} responses the review runs
 * over — an empty archive, or one nothing recognizes, is ordinary data the
 * review renders, not an error — and `unreadable` carries the one malformed-file
 * `ParseError`. The confirm step writes only the responses the review chose from
 * a `read` file. `id` is a per-pick stable identity for a React `key`, since two
 * files in a batch can share a name.
 */
type FileReadOutcome =
  | {
      readonly _tag: 'read'
      readonly id: string
      readonly picked: PickedHar
      readonly responses: readonly Extraction.Input[]
    }
  | {
      readonly _tag: 'unreadable'
      readonly id: string
      readonly picked: PickedHar
      readonly error: ParseResult.ParseError
    }

/**
 * The lifecycle of one batch read, holding every pick's outcome so the screen can
 * render one combined review.
 */
type ImportRunState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'reading' }
  | { readonly _tag: 'ready'; readonly files: readonly FileReadOutcome[] }

/** Imperative surface the screen drives the read through. */
interface ImportRun {
  readonly state: ImportRunState
  /** Read a freshly-picked batch of files into responses, replacing any previous one. */
  readonly run: (picks: readonly PickedHar[]) => void
  /** Discard the current read and return to `idle`. */
  readonly reset: () => void
}

/**
 * Drives a batch read as an imperative action, mapping each pick's `decode`
 * outcome onto a {@link FileReadOutcome}. The authed runner comes from router
 * context via `fhir-r4-react`, so mount this inside the host app's router.
 *
 * @param descriptor - The file format's descriptor (its `decode` + `defaultSettings`)
 * @returns The read surface: its `state`, the `run` trigger, and a `reset` back
 *   to `idle`
 */
const useImportRun = <TSettings, TResource, R>(
  descriptor: FileImporterDescriptor<TSettings, TResource, R>
): ImportRun => {
  const runAuthed = useRunAuthed()
  const [state, setState] = useState<ImportRunState>({ _tag: 'idle' })
  // A re-pick while a read is in flight must win — track the latest ticket so a
  // stale resolution is dropped rather than clobbering the newer review.
  const latest = useRef(0)

  const run = useCallback(
    (picks: readonly PickedHar[]): void => {
      if (picks.length === 0) return
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'reading' })
      // Each pick reads independently and concurrently; `catchAll` turns the sole
      // `ParseError` into an `unreadable` outcome, so one bad file in the batch is
      // a row rather than a whole-batch failure — the read Effect cannot fail.
      const readAll = Effect.forEach(
        picks,
        (picked) =>
          Effect.gen(function* () {
            const id = yield* Effect.sync(() => crypto.randomUUID())
            return yield* descriptor.decode(picked.text, descriptor.defaultSettings).pipe(
              Effect.map((responses): FileReadOutcome => ({ _tag: 'read', id, picked, responses })),
              Effect.catchAll((error) =>
                Effect.succeed<FileReadOutcome>({ _tag: 'unreadable', id, picked, error })
              )
            )
          }),
        { concurrency: 'unbounded' }
      )
      void runAuthed(readAll).then((files) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'ready', files })
      })
    },
    [descriptor, runAuthed]
  )

  const reset = useCallback((): void => {
    latest.current++
    setState({ _tag: 'idle' })
  }, [])

  return { state, run, reset }
}

export { type FileReadOutcome, type ImportRun, type ImportRunState, useImportRun }
