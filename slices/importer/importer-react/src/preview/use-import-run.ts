import { Effect, Match, type ParseResult } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import type { FhirResource } from 'fhir-r4/resources'
import {
  type DecodedFile,
  type DecodedUnit,
  identify,
  type LabeledResource,
  type PickedFileLike,
  sourceFileKey,
} from 'importer-fundamentals'

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
 * the registered descriptors, then grouped by format and decoded through
 * that format's batch `decode` under the format's current settings. A
 * format whose batch decode fails becomes `unreadable` outcomes for all
 * its files, and a file no descriptor claims becomes an `unrecognized`
 * row. Settings are pre-decode input, so {@link ImportRun.applySettings}
 * re-decodes every file of the changed format from its retained bytes.
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
    'format' | 'detect' | 'decode' | 'defaultSettings' | 'buildSourceFile'
  >
}

const SOURCE_SECTION_TITLE = 'Source file'

/**
 * A read outcome for one specific `K`. Default `K = FormatKind` gives the
 * discriminated union across every registered format. Carries the decoded
 * sections + notes — the review is a pure per-resource selection over
 * these, so there is no further per-format review state.
 *
 * @remarks
 * `files` is the picked files that form this unit — a single-file format
 * produces one-element arrays; a group format may merge several files.
 * `sourceFiles` is the per-file source-file archives, minted once at read
 * time so their ids and upload instants stay stable across settings
 * re-decodes — `undefined` entries for server picks or failed builds.
 * They are prepended to `decoded.sections` as titled sections, one per
 * file, so the generalized review renders, edits, and skips them like any
 * other resource.
 */
type ReadFile<K extends FormatKind> = {
  readonly [Kind in K]: {
    readonly _tag: 'read'
    readonly id: string
    readonly files: readonly PickedFile[]
    readonly format: Kind
    readonly decoded: DecodedFile<FhirResource>
    readonly sourceFiles: ReadonlyMap<string, LabeledResource<FhirResource>>
  }
}[K]

/**
 * A batch of files whose format was identified but whose
 * {@link BoundFormat.decode} rejected the bytes — the batch's `ParseError`.
 */
type UnreadableFile<K extends FormatKind> = {
  readonly [Kind in K]: {
    readonly _tag: 'unreadable'
    readonly id: string
    readonly files: readonly PickedFile[]
    readonly format: Kind
    readonly error: ParseResult.ParseError
    readonly sourceFiles: ReadonlyMap<string, LabeledResource<FhirResource>>
  }
}[K]

/** A picked file no registered descriptor's `detect` claimed. */
interface UnrecognizedFile {
  readonly _tag: 'unrecognized'
  readonly id: string
  readonly files: readonly PickedFile[]
}

/**
 * One unit's read outcome, tagged with the format that claimed it so the
 * settings form, the confirm, and the preview all dispatch on it.
 */
type FileReadOutcome = ReadFile<FormatKind> | UnreadableFile<FormatKind> | UnrecognizedFile

/**
 * The lifecycle of one batch read, holding every pick's outcome so the
 * screen can render one combined review.
 */
type ImportRunState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'reading' }
  | {
      readonly _tag: 'ready'
      readonly batchId: number
      readonly files: readonly FileReadOutcome[]
    }

/** Imperative surface the screen drives the read through. */
interface ImportRun {
  readonly state: ImportRunState
  readonly settings: FormatSettings
  readonly redecoding: boolean
  readonly run: (picks: readonly PickedFile[]) => void
  readonly applySettings: <K extends FormatKind>(format: K, settings: FormatSettings[K]) => void
  readonly reset: () => void
}

const identifyForRun = (registry: ImportRunRegistry, picked: PickedFile): FormatKind | undefined =>
  identify(Object.values(registry), picked)?.format

/**
 * Run the batch decode for one format, dispatching through `Match.type` so
 * the settings type lines up per branch.
 */
const runBatchDecode = (
  registry: ImportRunRegistry,
  settings: FormatSettings,
  format: FormatKind,
  files: readonly PickedFileLike[]
): Effect.Effect<readonly DecodedUnit<FhirResource>[], ParseResult.ParseError> =>
  Match.type<FormatKind>().pipe(
    Match.when('har', (kind) => registry[kind].decode(files, settings[kind])),
    Match.when('lifelabs-pdf', (kind) => registry[kind].decode(files, settings[kind])),
    Match.when('dicom', (kind) => registry[kind].decode(files, settings[kind])),
    Match.exhaustive
  )(format)

/**
 * Build source-file archives for every local pick in a unit, returning a
 * map from the per-file scoped key to its labeled resource. Server picks
 * and failed builds produce no entry.
 */
const buildSourceFiles = (
  registry: ImportRunRegistry,
  format: FormatKind,
  files: readonly PickedFile[]
): Effect.Effect<ReadonlyMap<string, LabeledResource<FhirResource>>> =>
  Effect.forEach(
    files,
    (file) => {
      if (file.source._tag !== 'local') return Effect.succeed(undefined)
      return Match.type<FormatKind>()
        .pipe(
          Match.when('har', (kind) => registry[kind].buildSourceFile(file)),
          Match.when('lifelabs-pdf', (kind) => registry[kind].buildSourceFile(file)),
          Match.when('dicom', (kind) => registry[kind].buildSourceFile(file)),
          Match.exhaustive
        )(format)
        .pipe(
          Effect.map((resource): LabeledResource<FhirResource> => ({
            key: sourceFileKey(file.fileName),
            title: file.fileName,
            resource,
          })),
          Effect.catchAll(() => Effect.succeed(undefined))
        )
    },
    { concurrency: 'unbounded' }
  ).pipe(
    Effect.map((results) => {
      const map = new Map<string, LabeledResource<FhirResource>>()
      for (const entry of results) {
        if (entry !== undefined) map.set(entry.key, entry)
      }
      return map
    })
  )

/**
 * Prepend source-file sections (one per file) above the extracted
 * resources, so the generalized review lists them like any other resource.
 */
const withSourceSections = (
  decoded: DecodedFile<FhirResource>,
  sourceFiles: ReadonlyMap<string, LabeledResource<FhirResource>>
): DecodedFile<FhirResource> => {
  if (sourceFiles.size === 0) return decoded
  const sections = [...sourceFiles.values()].map((sf) => ({
    title: SOURCE_SECTION_TITLE,
    resources: [sf],
  }))
  return { ...decoded, sections: [...sections, ...decoded.sections] }
}

/**
 * Look up the original PickedFile for a PickedFileLike returned by a
 * decode unit. The decode receives PickedFile objects (which satisfy
 * PickedFileLike structurally) and passes them through by reference.
 */
const lookupPicks = (
  unitFiles: readonly PickedFileLike[],
  pickMap: ReadonlyMap<PickedFileLike, PickedFile>
): readonly PickedFile[] =>
  unitFiles.map((f) => {
    const found = pickMap.get(f)
    if (found !== undefined) return found
    return { fileName: f.fileName, bytes: f.bytes, source: { _tag: 'local' as const } }
  })

/**
 * Group picks by format, batch-decode each format, build source files,
 * and produce one FileReadOutcome per decoded unit.
 */
const readBatch = (
  registry: ImportRunRegistry,
  settings: FormatSettings,
  picks: readonly PickedFile[]
): Effect.Effect<readonly FileReadOutcome[]> => {
  const groups = new Map<FormatKind, PickedFile[]>()
  const unrecognized: PickedFile[] = []
  const pickMap = new Map<PickedFileLike, PickedFile>()

  for (const pick of picks) {
    pickMap.set(pick, pick)
    const kind = identifyForRun(registry, pick)
    if (kind === undefined) {
      unrecognized.push(pick)
    } else {
      const list = groups.get(kind)
      if (list !== undefined) list.push(pick)
      else groups.set(kind, [pick])
    }
  }

  const unrecognizedOutcomes: FileReadOutcome[] = unrecognized.map((pick) => ({
    _tag: 'unrecognized',
    id: crypto.randomUUID(),
    files: [pick],
  }))

  const formatEffects = [...groups.entries()].map(([format, formatPicks]) =>
    Effect.gen(function* () {
      const sfMap = yield* buildSourceFiles(registry, format, formatPicks)
      const units = yield* runBatchDecode(registry, settings, format, formatPicks).pipe(
        Effect.map((decodedUnits): readonly FileReadOutcome[] =>
          decodedUnits.map((unit): FileReadOutcome => {
            const files = lookupPicks(unit.files, pickMap)
            const unitSfMap = new Map<string, LabeledResource<FhirResource>>()
            for (const file of files) {
              const sf = sfMap.get(sourceFileKey(file.fileName))
              if (sf !== undefined) unitSfMap.set(sf.key, sf)
            }
            return {
              _tag: 'read',
              id: crypto.randomUUID(),
              files,
              format,
              decoded: withSourceSections(unit.decoded, unitSfMap),
              sourceFiles: unitSfMap,
            }
          })
        ),
        Effect.catchAll((error): Effect.Effect<readonly FileReadOutcome[]> =>
          Effect.succeed([
            {
              _tag: 'unreadable',
              id: crypto.randomUUID(),
              files: formatPicks,
              format,
              error,
              sourceFiles: sfMap,
            },
          ])
        )
      )
      return units
    })
  )

  return Effect.forEach(formatEffects, (eff) => eff, { concurrency: 'unbounded' }).pipe(
    Effect.map((results) => [...results.flat(), ...unrecognizedOutcomes])
  )
}

/**
 * Re-decode the files of one format from retained bytes under new settings,
 * keeping source files stable.
 */
const redecodeFormat = (
  registry: ImportRunRegistry,
  settings: FormatSettings,
  format: FormatKind,
  files: readonly FileReadOutcome[]
): Effect.Effect<readonly FileReadOutcome[]> =>
  Effect.forEach(
    files,
    (file): Effect.Effect<readonly FileReadOutcome[]> => {
      if (file._tag === 'unrecognized' || file.format !== format) return Effect.succeed([file])
      const picks = file.files
      const existingSfMap = file.sourceFiles
      return runBatchDecode(registry, settings, format, picks).pipe(
        Effect.map((units): readonly FileReadOutcome[] =>
          units.map((unit): FileReadOutcome => {
            const unitSfMap = new Map<string, LabeledResource<FhirResource>>()
            for (const f of unit.files) {
              const key = sourceFileKey(f.fileName)
              const sf = existingSfMap.get(key)
              if (sf !== undefined) unitSfMap.set(key, sf)
            }
            return {
              _tag: 'read',
              id: file.id,
              files: file.files,
              format,
              decoded: withSourceSections(unit.decoded, unitSfMap),
              sourceFiles: unitSfMap,
            }
          })
        ),
        Effect.catchAll((error): Effect.Effect<readonly FileReadOutcome[]> =>
          Effect.succeed([
            {
              _tag: 'unreadable',
              id: file.id,
              files: file.files,
              format,
              error,
              sourceFiles: existingSfMap,
            },
          ])
        )
      )
    },
    { concurrency: 'unbounded' }
  ).pipe(Effect.map((results) => results.flat()))

const useImportRun = (registry: ImportRunRegistry): ImportRun => {
  const runAuthed = useRunAuthed()
  const [state, setState] = useState<ImportRunState>({ _tag: 'idle' })
  const [settings, setSettings] = useState<FormatSettings>(defaultFormatSettings)
  const [redecoding, setRedecoding] = useState(false)
  const latest = useRef(0)
  const batch = useRef(0)
  const settingsRef = useRef(settings)

  const run = useCallback(
    (picks: readonly PickedFile[]): void => {
      if (picks.length === 0) return
      latest.current += 1
      batch.current += 1
      const ticket = latest.current
      const batchId = batch.current
      setState({ _tag: 'reading' })
      const current = settingsRef.current
      void runAuthed(readBatch(registry, current, picks)).then((files) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'ready', batchId, files })
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
      void runAuthed(redecodeFormat(registry, merged, format, state.files)).then((nextFiles) => {
        if (latest.current !== ticket) return
        setRedecoding(false)
        setState({ _tag: 'ready', batchId, files: nextFiles })
      })
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
