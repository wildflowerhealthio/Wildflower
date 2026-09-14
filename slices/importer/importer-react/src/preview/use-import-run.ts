import { Effect, Match, type ParseResult } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import type { FhirResource } from 'fhir-r4/resources'
import { type DecodedFile, identify, type LabeledResource } from 'importer-fundamentals'

import {
  type BoundFormat,
  defaultFormatSettings,
  type FormatKind,
  type FormatSettings,
} from '../registry.ts'
import type { PickedFile } from '../sources/picked-file.ts'

/**
 * Running the read half of the import — each picked file's format-specific
 * `decode` — over a batch of {@link PickedFile}s, and holding each one's
 * decoded sections for the screen to review, alongside the per-format
 * settings the decodes ran under.
 *
 * @remarks
 * The pure, non-writing side of the flow: each pick is identified against
 * the registered descriptors, then decoded independently through its
 * matching format's `decode` under that format's current settings. A
 * malformed file becomes its own `unreadable` row rather than a whole-batch
 * error, and a file no descriptor claims becomes an `unrecognized` row named
 * against its own name — even though the picker rejects those upstream, the
 * type here documents that decode only ever runs on a file some descriptor
 * claimed. Settings are pre-decode input, so {@link ImportRun.applySettings}
 * re-decodes every file of the changed format from its retained bytes — an
 * `unreadable` file included, since new settings could in principle read it.
 * Run through `useRunAuthed` (the slice's one runner) even though a decode
 * needs no auth; the write client stays unreachable by `decode`'s own
 * construction, not by anything this hook does.
 *
 * @packageDocumentation
 */

/**
 * The registry-shaped structure {@link useImportRun} reads to route each
 * pick: for every registered {@link FormatKind}, its `detect` (identifies
 * the pick) and its `decode` + `defaultSettings` (opens the pick's decoded
 * sections).
 *
 * @remarks
 * Not the whole `BoundFormat<K>` — this hook needs no `persist` or
 * `SettingsPicker` — so a test can stand up a fake registry with just
 * these fields.
 */
type ImportRunRegistry = {
  readonly [K in FormatKind]: Pick<
    BoundFormat<K>,
    'format' | 'detect' | 'decode' | 'defaultSettings' | 'sourceArchive'
  >
}

/**
 * The stable review key and section title for a local pick's source-file
 * archive `DocumentReference`. The key is fixed (one archive per file), so a
 * settings re-decode leaves the reviewer's edit or skip of it applying; the
 * title heads its own section in the preview, above the extracted resources.
 */
const SOURCE_ARCHIVE_KEY = 'source-archive'
const SOURCE_SECTION_TITLE = 'Source file'

/**
 * A read file for one specific `K`. Default `K = FormatKind` gives the
 * discriminated union across every registered format; `ReadFile<'har'>`
 * alone gives just the HAR variant for a per-K caller. Carries the decoded
 * sections + notes — the review is a pure per-resource selection over
 * these, so there is no further per-format review state.
 *
 * @remarks
 * `sourceArchive` is the local pick's source-file `DocumentReference` as a
 * {@link LabeledResource}, minted once at read time so its id and upload
 * instant stay stable across settings re-decodes — `undefined` for a server
 * pick (its archive already exists) or when the archive could not be built.
 * It is prepended to `decoded.sections` as its own "Source file" section, so
 * the generalized review renders, edits, and skips it like any other
 * resource; the field is kept alongside so a re-decode can re-inject the same
 * archive rather than mint a fresh one.
 */
type ReadFile<K extends FormatKind> = {
  readonly [Kind in K]: {
    readonly _tag: 'read'
    readonly id: string
    readonly picked: PickedFile
    readonly format: Kind
    readonly decoded: DecodedFile<FhirResource>
    readonly sourceArchive: LabeledResource<FhirResource> | undefined
  }
}[K]

/**
 * A file whose format was identified but whose {@link BoundFormat.decode}
 * rejected the bytes — the pick's own `ParseError`. Distributed over `K`
 * the same way {@link ReadFile} is, so a future per-format detail on the
 * variant lines up cleanly.
 *
 * @remarks
 * Carries the same `sourceArchive` as {@link ReadFile} so that a settings
 * re-decode which turns this file readable re-injects the archive minted on
 * the first read rather than a fresh one.
 */
type UnreadableFile<K extends FormatKind> = {
  readonly [Kind in K]: {
    readonly _tag: 'unreadable'
    readonly id: string
    readonly picked: PickedFile
    readonly format: Kind
    readonly error: ParseResult.ParseError
    readonly sourceArchive: LabeledResource<FhirResource> | undefined
  }
}[K]

/** A picked file no registered descriptor's `detect` claimed. No format, no sections. */
interface UnrecognizedFile {
  readonly _tag: 'unrecognized'
  readonly id: string
  readonly picked: PickedFile
}

/**
 * One pick's read outcome, tagged with the format that claimed it so the
 * settings form, the confirm, and the preview all dispatch on it.
 *
 * @remarks
 * The union of {@link ReadFile}, {@link UnreadableFile}, and
 * {@link UnrecognizedFile}. `read` carries the file's decoded sections +
 * notes; `unreadable` carries the one malformed-file `ParseError` under its
 * format tag; `unrecognized` is a file no descriptor claimed — no format
 * tag, no sections, just the pick under its own name. The confirm step
 * writes only the resources the review chose from a `read` file. `id` is a
 * per-pick stable identity for a React `key`, since two files in a batch
 * can share a name; it survives a settings re-decode, so per-resource
 * selections keyed by file id keep applying.
 */
type FileReadOutcome = ReadFile<FormatKind> | UnreadableFile<FormatKind> | UnrecognizedFile

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
  /** The current per-format settings every decode runs under. */
  readonly settings: FormatSettings
  /**
   * Read a freshly-picked batch of files into decoded sections, replacing
   * any previous one.
   */
  readonly run: (picks: readonly PickedFile[]) => void
  /**
   * Change one format's settings and re-decode that format's files (read
   * and unreadable alike) from their retained bytes. Other formats' files
   * and every file's id are untouched.
   */
  readonly applySettings: <K extends FormatKind>(format: K, settings: FormatSettings[K]) => void
  /** Discard the current read and return to `idle` (settings persist). */
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
 * Run one registered format's `decode` on the picked bytes under the
 * format's current settings, dispatching through `Match.type` on
 * `FormatKind` so `kind` narrows to a specific `K` per branch — a
 * `BoundFormat<K>` and its `FormatSettings[K]` line up naturally inside
 * each branch.
 */
const runDecode = (
  registry: ImportRunRegistry,
  settings: FormatSettings,
  format: FormatKind,
  bytes: Uint8Array
): Effect.Effect<DecodedFile<FhirResource>, ParseResult.ParseError> =>
  Match.type<FormatKind>().pipe(
    Match.when('har', (kind) => registry[kind].decode(bytes, settings[kind])),
    Match.when('lifelabs-pdf', (kind) => registry[kind].decode(bytes, settings[kind])),
    Match.exhaustive
  )(format)

/**
 * Build one local pick's source-file archive `DocumentReference` through its
 * format's `sourceArchive`, dispatched with `Match.type` so `kind` narrows to
 * a specific `K` per branch — no cast. A server pick has none (its archive is
 * already on the server), and a build failure (a near-impossible `ParseError`
 * — a digest unavailable in an insecure context) folds to `undefined` so the
 * file still imports, just with no source-file section to review.
 */
const buildSourceArchive = (
  registry: ImportRunRegistry,
  format: FormatKind,
  picked: PickedFile
): Effect.Effect<LabeledResource<FhirResource> | undefined> => {
  if (picked.source._tag !== 'local') return Effect.succeed(undefined)
  return Match.type<FormatKind>()
    .pipe(
      Match.when('har', (kind) => registry[kind].sourceArchive(picked)),
      Match.when('lifelabs-pdf', (kind) => registry[kind].sourceArchive(picked)),
      Match.exhaustive
    )(format)
    .pipe(
      Effect.map((resource): LabeledResource<FhirResource> => ({
        key: SOURCE_ARCHIVE_KEY,
        title: picked.fileName,
        resource,
      })),
      Effect.catchAll(() => Effect.succeed(undefined))
    )
}

/**
 * Prepend the source-file archive as its own titled section, above the
 * extracted resources, so the generalized review lists it like any other
 * resource. A decode with no archive (a server pick, or a build that failed)
 * is returned unchanged.
 */
const withSourceSection = (
  decoded: DecodedFile<FhirResource>,
  sourceArchive: LabeledResource<FhirResource> | undefined
): DecodedFile<FhirResource> =>
  sourceArchive === undefined
    ? decoded
    : {
        ...decoded,
        sections: [
          { title: SOURCE_SECTION_TITLE, resources: [sourceArchive] },
          ...decoded.sections,
        ],
      }

/**
 * Decode one identified pick under `settings` and fold its outcome into a
 * {@link FileReadOutcome}, prepending the (already-minted) source-file section
 * on success. Both the `read` and `unreadable` outcomes carry `sourceArchive`,
 * so a settings re-decode re-injects the same archive rather than mint a fresh
 * one.
 */
const decodeInto = (
  registry: ImportRunRegistry,
  settings: FormatSettings,
  format: FormatKind,
  picked: PickedFile,
  id: string,
  sourceArchive: LabeledResource<FhirResource> | undefined
): Effect.Effect<FileReadOutcome> =>
  runDecode(registry, settings, format, picked.bytes).pipe(
    Effect.map((decoded): FileReadOutcome => ({
      _tag: 'read',
      id,
      picked,
      format,
      decoded: withSourceSection(decoded, sourceArchive),
      sourceArchive,
    })),
    Effect.catchAll((error) =>
      Effect.succeed<FileReadOutcome>({
        _tag: 'unreadable',
        id,
        picked,
        format,
        error,
        sourceArchive,
      })
    )
  )

/**
 * Read one pick end-to-end: identify its format, mint its source-file archive
 * (local picks only, minted once here so a later re-decode reuses it), then
 * decode. The archive mint runs before the decode so it exists whether the
 * decode succeeds or fails.
 */
const readOne = (
  registry: ImportRunRegistry,
  settings: FormatSettings,
  picked: PickedFile,
  id: string
): Effect.Effect<FileReadOutcome> => {
  const kind = identifyForRun(registry, picked)
  if (kind === undefined) {
    return Effect.succeed<FileReadOutcome>({ _tag: 'unrecognized', id, picked })
  }
  return buildSourceArchive(registry, kind, picked).pipe(
    Effect.flatMap((sourceArchive) =>
      decodeInto(registry, settings, kind, picked, id, sourceArchive)
    )
  )
}

/**
 * Drives a batch read as an imperative action, mapping each pick's `decode`
 * outcome onto a {@link FileReadOutcome}, and re-decoding a format's files
 * when its settings change. The authed runner comes from router context via
 * `fhir-r4-react`, so mount this inside the host app's router.
 *
 * @param registry - The registered formats' identify/decode surface, indexed
 *   by format kind
 * @returns The read surface: its `state`, the current per-format `settings`,
 *   the `run` trigger, `applySettings`, and a `reset` back to `idle`
 */
const useImportRun = (registry: ImportRunRegistry): ImportRun => {
  const runAuthed = useRunAuthed()
  const [state, setState] = useState<ImportRunState>({ _tag: 'idle' })
  const [settings, setSettings] = useState<FormatSettings>(defaultFormatSettings)
  const latest = useRef(0)
  // The settings the in-flight (or latest) decode ran under — read by
  // applySettings so a re-decode composes with the freshest value even
  // before React commits the state update.
  const settingsRef = useRef(settings)

  const run = useCallback(
    (picks: readonly PickedFile[]): void => {
      if (picks.length === 0) return
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'reading' })
      const current = settingsRef.current
      const readAll = Effect.forEach(
        picks,
        (picked) =>
          Effect.gen(function* () {
            const id = yield* Effect.sync(() => crypto.randomUUID())
            return yield* readOne(registry, current, picked, id)
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

  const applySettings = useCallback(
    <K extends FormatKind>(format: K, next: FormatSettings[K]): void => {
      const merged: FormatSettings = { ...settingsRef.current, [format]: next }
      settingsRef.current = merged
      setSettings(merged)
      if (state._tag !== 'ready') return
      latest.current += 1
      const ticket = latest.current
      const redecodeAll = Effect.forEach(
        state.files,
        (file) =>
          file._tag !== 'unrecognized' && file.format === format
            ? // Reuse the archive minted on the first read — never mint a fresh
              // one on a settings change, so its id (and the reviewer's edit or
              // skip of it) stays stable across re-decodes.
              decodeInto(registry, merged, file.format, file.picked, file.id, file.sourceArchive)
            : Effect.succeed(file),
        { concurrency: 'unbounded' }
      )
      void runAuthed(redecodeAll).then((nextFiles) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'ready', files: nextFiles })
      })
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- react/memo-dependencies (React Compiler) is authoritative and says registry is unnecessary
    [runAuthed, state]
  )

  const reset = useCallback((): void => {
    latest.current++
    setState({ _tag: 'idle' })
  }, [])

  return { state, settings, run, applySettings, reset }
}

export {
  type FileReadOutcome,
  type ImportRun,
  type ImportRunRegistry,
  type ImportRunState,
  type ReadFile,
  type UnreadableFile,
  type UnrecognizedFile,
  useImportRun,
}
