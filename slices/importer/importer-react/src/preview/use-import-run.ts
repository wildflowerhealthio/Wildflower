import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import {
  defaultFormatSettings,
  type FormatKind,
  type FormatSettings,
  readBatch,
  type ReadRegistry,
  redecodeFormat,
  type UnitReadOutcome,
} from 'importer-core'
import type { PickedFile } from 'importer-fundamentals'

/**
 * Running the read half of the import over a batch of {@link PickedFile}s —
 * `importer-core`'s `readBatch` — and holding each unit's outcome for the
 * screen to review, alongside the per-format settings the decodes ran under.
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
 * @packageDocumentation
 */

/**
 * The lifecycle of one batch read, holding every unit's outcome so the
 * screen can render one combined review.
 */
type ImportRunState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'reading' }
  | {
      readonly _tag: 'ready'
      /**
       * Identifies the picked batch. Advances on {@link ImportRun.run} and is
       * preserved by {@link ImportRun.applySettings}, so a consumer can tell a
       * *fresh pick* from a re-decode of the same files — which `units` alone
       * cannot say, since a re-decode replaces that array too. The server-diff
       * pre-fetch uses it to decide whether the previous classification may
       * stay on screen while the next one loads.
       */
      readonly batchId: number
      readonly units: readonly UnitReadOutcome[]
    }

/** Imperative surface the screen drives the read through. */
interface ImportRun {
  readonly state: ImportRunState
  /** The current per-format settings every decode runs under. */
  readonly settings: FormatSettings
  /** Whether a settings re-decode is in flight — the shell blocks confirm while true. */
  readonly redecoding: boolean
  /** Read a freshly-picked batch of files into review units, replacing any previous one. */
  readonly run: (picks: readonly PickedFile[]) => void
  /**
   * Change one format's settings and re-decode that format's units from
   * their retained files. Other formats' units and every unit's id are
   * untouched.
   */
  readonly applySettings: <K extends FormatKind>(format: K, settings: FormatSettings[K]) => void
  /** Discard the current read and return to `idle` (settings persist). */
  readonly reset: () => void
}

/** Where a unit's identity comes from: the platform's UUID, minted per unit at read time. */
const newUnitId = (): string => crypto.randomUUID()

/**
 * Drives a batch read as an imperative action and re-decodes a format's
 * units when its settings change. The authed runner comes from router
 * context via `fhir-r4-react`, so mount this inside the host app's router.
 *
 * @param registry - The registered formats' `detect` / `decode` surface,
 *   indexed by format kind
 * @returns The read surface: its `state`, the current per-format `settings`,
 *   the `run` trigger, `applySettings`, and a `reset` back to `idle`
 */
const useImportRun = (registry: ReadRegistry): ImportRun => {
  const runAuthed = useRunAuthed()
  const [state, setState] = useState<ImportRunState>({ _tag: 'idle' })
  const [settings, setSettings] = useState<FormatSettings>(defaultFormatSettings)
  const [redecoding, setRedecoding] = useState(false)
  const latest = useRef(0)
  // Advanced only by `run`, so it names the picked batch rather than the
  // decode pass — see `ImportRunState`'s `batchId`.
  const batch = useRef(0)
  // The settings the in-flight (or latest) decode ran under — read by
  // applySettings so a re-decode composes with the freshest value even
  // before React commits the state update.
  const settingsRef = useRef(settings)

  const run = useCallback(
    (picks: readonly PickedFile[]): void => {
      if (picks.length === 0) return
      latest.current += 1
      batch.current += 1
      const ticket = latest.current
      const batchId = batch.current
      setState({ _tag: 'reading' })
      void runAuthed(readBatch(registry, settingsRef.current, picks, newUnitId)).then((units) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'ready', batchId, units })
      })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- react/memo-dependencies (React Compiler) is authoritative and says registry is unnecessary
    [runAuthed]
  )

  const applySettings = useCallback(
    <K extends FormatKind>(format: K, next: FormatSettings[K]): void => {
      const merged: FormatSettings = { ...settingsRef.current, [format]: next }
      settingsRef.current = merged
      setSettings(merged)
      if (state._tag !== 'ready') return
      latest.current += 1
      const ticket = latest.current
      const { batchId } = state
      setRedecoding(true)
      void runAuthed(redecodeFormat(registry, merged, format, state.units, newUnitId)).then(
        (units) => {
          if (latest.current !== ticket) return
          setRedecoding(false)
          setState({ _tag: 'ready', batchId, units })
        }
      )
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- react/memo-dependencies (React Compiler) is authoritative and says registry is unnecessary
    [runAuthed, state]
  )

  const reset = useCallback((): void => {
    latest.current++
    setRedecoding(false)
    setState({ _tag: 'idle' })
  }, [])

  return { state, settings, redecoding, run, applySettings, reset }
}

export { type ImportRun, type ImportRunState, useImportRun }
