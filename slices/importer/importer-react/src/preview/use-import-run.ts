import { Effect, Either, type ParseResult } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import { type ImportPreview, runHarImport } from 'importer-core'

import type { PickedHar } from '../sources/picked-har.ts'

/**
 * Running the read half of the import — `importer-core`'s `runHarImport` — over a
 * {@link PickedHar}, and holding its {@link ImportPreview} for the screen.
 *
 * @remarks
 * This is the pure, non-writing side of the flow: `runHarImport` decodes the
 * archive, detects the collector, replays its offline entities, and folds the
 * result, requiring no services and writing nothing. It is run through
 * `fhir-r4-react`'s `useRunAuthed` — the one runner every source in this slice
 * already reads from router context — even though a preview needs no auth, so the
 * whole slice drives one runner rather than reaching for `Effect.runPromise`
 * here. The write client stays unreachable from a preview by `runHarImport`'s own
 * construction, not by anything this hook does.
 *
 * A malformed archive is the only failure `runHarImport` has, surfaced as
 * `unreadable`. A local pick was already validated through the HAR parser at the
 * picker, so this rarely fires for one — but a server archive is decoded, not
 * re-validated, so the state exists for it.
 *
 * @packageDocumentation
 */

/**
 * The lifecycle of one read, holding the pick alongside its result so the screen
 * can hand both to the confirm step.
 *
 * @remarks
 * `ready` carries the whole {@link ImportPreview} union — a `NoCollectorClaims`
 * is a first-class outcome the preview view renders, not an error, so it lands
 * here as an ordinary ready state and only the malformed-archive case reaches
 * `unreadable`.
 */
type ImportRunState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'reading' }
  | { readonly _tag: 'ready'; readonly picked: PickedHar; readonly preview: ImportPreview }
  | {
      readonly _tag: 'unreadable'
      readonly picked: PickedHar
      readonly error: ParseResult.ParseError
    }

/** Imperative surface the screen drives the read through. */
interface ImportRun {
  readonly state: ImportRunState
  /** Read a freshly-picked HAR into a preview, replacing any previous one. */
  readonly run: (picked: PickedHar) => void
  /** Discard the current read and return to `idle`. */
  readonly reset: () => void
}

/**
 * Drives a single archive read as an imperative action, mapping `runHarImport`'s
 * outcome onto {@link ImportRunState}. The authed runner comes from router
 * context via `fhir-r4-react`, so mount this inside the host app's router.
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
    (picked: PickedHar): void => {
      const ticket = ++latest.current
      setState({ _tag: 'reading' })
      // `Effect.either` moves the sole `ParseError` onto the value channel, so the
      // runner resolves rather than rejects and the two outcomes are one branch.
      void runAuthed(Effect.either(runHarImport(picked.text))).then((result) => {
        if (latest.current !== ticket) return
        setState(
          Either.match(result, {
            onLeft: (error) => ({ _tag: 'unreadable', picked, error }) as const,
            onRight: (preview) => ({ _tag: 'ready', picked, preview }) as const,
          })
        )
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

export { type ImportRun, type ImportRunState, useImportRun }
