import { Effect, Match, type ParseResult } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import { identify } from 'importer-fundamentals'

import type { BoundFormat, FormatKind, FormatVariant } from '../registry.tsx'
import type { PickedFile } from '../sources/picked-file.ts'

/**
 * Running the read half of the import — each picked file's format-specific
 * `decode` — over a batch of {@link PickedFile}s, and holding each one's
 * decoded review state for the screen to review.
 *
 * @remarks
 * The pure, non-writing side of the flow: each pick is identified against
 * the registered descriptors, then decoded independently through its
 * matching format's `decode`. A malformed file becomes its own `unreadable`
 * row rather than a whole-batch error, and a file no descriptor claims
 * becomes an `unrecognized` row named against its own name — even though
 * the picker rejects those upstream, the type here documents that decode
 * only ever runs on a file some descriptor claimed. Run through
 * `useRunAuthed` (the slice's one runner) even though a decode needs no
 * auth; the write client stays unreachable by `decode`'s own construction,
 * not by anything this hook does.
 *
 * @packageDocumentation
 */

/**
 * The registry-shaped structure {@link useImportRun} reads to route each
 * pick: for every registered {@link FormatKind}, its `detect` (identifies
 * the pick) and its `decode` + `defaultSettings` (opens the pick's review
 * state).
 *
 * @remarks
 * Not the whole `BoundFormat<K>` — this hook needs no `resolve`, `persist`,
 * or `SettingsPicker` — so a test can stand up a fake registry with just
 * these fields.
 */
type ImportRunRegistry = {
  readonly [K in FormatKind]: Pick<
    BoundFormat<K>,
    'format' | 'detect' | 'decode' | 'defaultSettings'
  >
}

/**
 * One pick's read outcome, tagged with the format that claimed it so a
 * confirm and a preview can look the right format's `resolve` and
 * `persist` up.
 *
 * @remarks
 * `read` carries the format's opaque review state — an empty file, or one
 * that yields nothing, is ordinary data the review renders — and
 * `unreadable` carries the one malformed-file `ParseError`. The confirm
 * step writes only the resources the review chose from a `read` file.
 * `id` is a per-pick stable identity for a React `key`, since two files
 * in a batch can share a name.
 */
type FileReadOutcome =
  | {
      readonly _tag: 'read'
      readonly id: string
      readonly picked: PickedFile
      readonly format: FormatKind
      readonly review: FormatVariant[FormatKind]['review']
    }
  | {
      readonly _tag: 'unreadable'
      readonly id: string
      readonly picked: PickedFile
      readonly format: FormatKind
      readonly error: ParseResult.ParseError
    }
  | {
      readonly _tag: 'unrecognized'
      readonly id: string
      readonly picked: PickedFile
    }

/**
 * The lifecycle of one batch read, holding every pick's outcome so the
 * screen can render one combined review.
 */
type ImportRunState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'reading' }
  | { readonly _tag: 'ready'; readonly files: readonly FileReadOutcome[] }

/** Imperative surface the screen drives the read through. */
interface ImportRun {
  readonly state: ImportRunState
  /**
   * Read a freshly-picked batch of files into review states, replacing any
   * previous one.
   */
  readonly run: (picks: readonly PickedFile[]) => void
  /** Discard the current read and return to `idle`. */
  readonly reset: () => void
}

/**
 * The picker gates on `detect`, but re-identify here — the picker is one
 * source of picks (server picks come pre-typed as HAR-archive references),
 * and the identification is the fact this hook must not assume.
 */
const identifyForRun = (registry: ImportRunRegistry, picked: PickedFile): FormatKind | undefined =>
  identify(Object.values(registry), picked)?.format

/**
 * The result of running one format's `decode` on a pick — the union of every
 * registered format's own review type.
 */
type AnyReviewEffect = Effect.Effect<FormatVariant[FormatKind]['review'], ParseResult.ParseError>

/**
 * Run one registered format's `decode` on the picked bytes, dispatching
 * through `Match.type` on `FormatKind` so TS narrows `format` to a specific K
 * per branch — a `BoundFormat<K>` and its `defaultSettings` line up naturally
 * inside each branch, no cast needed.
 */
const runDecode = (
  registry: ImportRunRegistry,
  format: FormatKind,
  bytes: Uint8Array
): AnyReviewEffect =>
  Match.type<FormatKind>().pipe(
    Match.when('har', (kind) => {
      const bound = registry[kind]
      return bound.decode(bytes, bound.defaultSettings)
    }),
    Match.when('lifelabs-pdf', (kind) => {
      const bound = registry[kind]
      return bound.decode(bytes, bound.defaultSettings)
    }),
    Match.exhaustive
  )(format)

/** Read one pick through its matching format's decode. */
const readOne = (
  registry: ImportRunRegistry,
  picked: PickedFile,
  id: string
): Effect.Effect<FileReadOutcome> => {
  const kind = identifyForRun(registry, picked)
  if (kind === undefined) {
    return Effect.succeed<FileReadOutcome>({ _tag: 'unrecognized', id, picked })
  }
  return runDecode(registry, kind, picked.bytes).pipe(
    Effect.map((review): FileReadOutcome => ({
      _tag: 'read',
      id,
      picked,
      format: kind,
      review,
    })),
    Effect.catchAll((error) =>
      Effect.succeed<FileReadOutcome>({
        _tag: 'unreadable',
        id,
        picked,
        format: kind,
        error,
      })
    )
  )
}

/**
 * Drives a batch read as an imperative action, mapping each pick's `decode`
 * outcome onto a {@link FileReadOutcome}. The authed runner comes from
 * router context via `fhir-r4-react`, so mount this inside the host app's
 * router.
 *
 * @param registry - The registered formats' identify/decode surface, indexed
 *   by format kind
 * @returns The read surface: its `state`, the `run` trigger, and a `reset`
 *   back to `idle`
 */
const useImportRun = (registry: ImportRunRegistry): ImportRun => {
  const runAuthed = useRunAuthed()
  const [state, setState] = useState<ImportRunState>({ _tag: 'idle' })
  const latest = useRef(0)

  const run = useCallback(
    (picks: readonly PickedFile[]): void => {
      if (picks.length === 0) return
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'reading' })
      const readAll = Effect.forEach(
        picks,
        (picked) =>
          Effect.gen(function* () {
            const id = yield* Effect.sync(() => crypto.randomUUID())
            return yield* readOne(registry, picked, id)
          }),
        { concurrency: 'unbounded' }
      )
      void runAuthed(readAll).then((files) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'ready', files })
      })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- react/memo-dependencies (React Compiler) is authoritative and says registry is unnecessary
    [runAuthed]
  )

  const reset = useCallback((): void => {
    latest.current++
    setState({ _tag: 'idle' })
  }, [])

  return { state, run, reset }
}

export {
  type FileReadOutcome,
  type ImportRun,
  type ImportRunRegistry,
  type ImportRunState,
  useImportRun,
}
