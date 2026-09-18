import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import {
  type BatchDecodeResult,
  defaultFormatSettings,
  type FormatKind,
  type FormatSettings,
  readBatch,
  redecodeFormat,
} from 'importer-core'
import type { PickedFile } from 'importer-fundamentals'

import { formatRegistry } from '../registry.ts'

/**
 * Running the read half of the import over a batch of {@link PickedFile}s —
 * `importer-core`'s `readBatch` — and holding the {@link BatchDecodeResult}
 * for the screen to review, alongside the per-format settings the decodes
 * ran under.
 *
 * @remarks
 * The React state around a pure core: this hook owns the batch lifecycle
 * (`idle` → `reading` → `ready`), the `FormatSettings` record, the
 * in-flight ticket that drops a stale result, and nothing else. Grouping
 * picks by format, decoding, folding outcomes, and re-decoding one format
 * under new settings all live in `importer-core`, which knows nothing of
 * React. Run through `useRunAuthed` (the slice's one runner) even though a
 * decode needs no auth; the write client stays unreachable by `decode`'s own
 * construction, not by anything this hook does.
 *
 * The registry is the shell's own `formatRegistry`, imported rather than
 * taken as a parameter: there is one, the hook is mounted once, and a
 * parameter only bought dependency arrays that had to be lied about.
 *
 * @packageDocumentation
 */

/**
 * The lifecycle of one batch read, holding the decode result so the screen
 * can render one combined review.
 */
type ImportRunState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'reading' }
  | {
      readonly _tag: 'ready'
      /**
       * Identifies the picked batch. Advances on {@link ImportRun.run} and is
       * preserved by {@link ImportRun.applySettings}, so a consumer can tell a
       * *fresh pick* from a re-decode of the same files — which `batch` alone
       * cannot say, since a re-decode replaces it too. The server-diff
       * pre-fetch uses it to decide whether the previous classification may
       * stay on screen while the next one loads.
       */
      readonly batchId: number
      readonly batch: BatchDecodeResult
    }

/** Imperative surface the screen drives the read through. */
interface ImportRun {
  readonly state: ImportRunState
  /** The current per-format settings every decode runs under. */
  readonly settings: FormatSettings
  /** Whether a settings re-decode is in flight — the shell blocks confirm while true. */
  readonly redecoding: boolean
  /** Read a freshly-picked batch of files into review units, replacing any previous one. */
  readonly run: (picks: readonly PickedFile.PickedFile[]) => void
  /**
   * Change one format's settings and re-decode that format's files from
   * their retained picks. Other formats' results and every id are
   * untouched.
   */
  readonly applySettings: <K extends FormatKind>(format: K, settings: FormatSettings[K]) => void
  /** Discard the current read and return to `idle` (settings persist). */
  readonly reset: () => void
}

/** Everything a decode reads before it starts: the settings to compose onto, and the batch to re-decode from. */
interface Current {
  readonly settings: FormatSettings
  readonly run: ImportRunState
}

const INITIAL_CURRENT: Current = { settings: defaultFormatSettings, run: { _tag: 'idle' } }

/**
 * Drives a batch read as an imperative action and re-decodes a format's
 * files when its settings change. The authed runner comes from router
 * context via `fhir-r4-react`, so mount this inside the host app's router.
 *
 * @returns The read surface: its `state`, the current per-format `settings`,
 *   the `run` trigger, `applySettings`, and a `reset` back to `idle`
 */
const useImportRun = (): ImportRun => {
  const runAuthed = useRunAuthed()
  const [state, setState] = useState<ImportRunState>(INITIAL_CURRENT.run)
  const [settings, setSettings] = useState<FormatSettings>(INITIAL_CURRENT.settings)
  const [redecoding, setRedecoding] = useState(false)
  const latest = useRef(0)
  // Advanced only by `run`, so it names the picked batch rather than the
  // decode pass — see `ImportRunState`'s `batchId`.
  const batchCounter = useRef(0)
  // What the *next* decode reads, as opposed to what this render shows: two
  // settings changes in one tick must compose, so the second has to see the
  // first's value before React commits it, and reading the batch here rather
  // than closing over it keeps every action below identity-stable.
  const current = useRef<Current>(INITIAL_CURRENT)

  // Write both the ref the actions read and the state the screen renders, so
  // the two can never disagree.
  const commitRun = useCallback((run: ImportRunState): void => {
    current.current = { ...current.current, run }
    setState(run)
  }, [])

  const run = useCallback(
    (picks: readonly PickedFile.PickedFile[]): void => {
      if (picks.length === 0) return
      latest.current += 1
      batchCounter.current += 1
      const ticket = latest.current
      const batchId = batchCounter.current
      commitRun({ _tag: 'reading' })
      void runAuthed(readBatch(formatRegistry, current.current.settings, picks)).then((batch) => {
        if (latest.current !== ticket) return
        commitRun({ _tag: 'ready', batchId, batch })
      })
    },
    [commitRun, runAuthed]
  )

  const applySettings = useCallback(
    <K extends FormatKind>(format: K, next: FormatSettings[K]): void => {
      const merged: FormatSettings = { ...current.current.settings, [format]: next }
      current.current = { ...current.current, settings: merged }
      setSettings(merged)
      const { run: pending } = current.current
      if (pending._tag !== 'ready') return
      latest.current += 1
      const ticket = latest.current
      const { batchId } = pending
      setRedecoding(true)
      void runAuthed(redecodeFormat(formatRegistry, merged, format, pending.batch)).then(
        (batch) => {
          if (latest.current !== ticket) return
          setRedecoding(false)
          commitRun({ _tag: 'ready', batchId, batch })
        }
      )
    },
    [commitRun, runAuthed]
  )

  const reset = useCallback((): void => {
    latest.current++
    setRedecoding(false)
    commitRun({ _tag: 'idle' })
  }, [commitRun])

  return { state, settings, redecoding, run, applySettings, reset }
}

export { type ImportRun, type ImportRunState, useImportRun }
