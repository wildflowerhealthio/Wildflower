import {
  type FileImporter,
  FormatDecode,
  FormatDetector,
  type PickedFile,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Option, pipe, Record } from 'effect'

import { importDecoded } from './import-decoded.ts'
import { type FormatKind, formatKinds, type FormatSettings } from './registry.ts'
import type * as ReviewGroup from './review-group.ts'

/**
 * The read half of an import as pure functions over the registry: group a
 * picked batch by the format that claims each file, run every format's
 * batch `decode` under its current settings and import what it decoded
 * (`importDecoded`), and re-decode one format when its settings change. No
 * writes, and no services but what the registry's decodes require —
 * `DecodeRequirements` for the real registry — which the shell provides when
 * it runs these and holds the result.
 *
 * @remarks
 * The registry is a record keyed by {@link FormatKind}, so a caller holding a
 * `kind: FormatKind` cannot index `registry[kind].decode(files, settings[kind])`
 * directly — TypeScript does not correlate the two union-indexed accesses.
 * {@link decodeFormat} closes that gap with a generic `K`: inside it `kind` is
 * one specific `K`, so `registry[kind]` is that format's importer and
 * `settings[kind]` its `FormatSettings[K]`, with no per-format branch to keep
 * in step with the registry.
 *
 * Past the decode the correlation is gone: every format's review group is
 * one type, so the batch's groups are its claimed files' record mapped
 * (`Record.fromEntries`), and a re-decode replaces one key of it.
 *
 * @packageDocumentation
 */

/**
 * The registry surface the read half needs: each format's `format` and
 * `detect` (to identify a pick), `decode` (to read it), and its source-file
 * constants and hooks (to import it). Not the whole `BoundFormat`, so a test
 * can stand up a fake registry with just these fields.
 *
 * @typeParam R - What the registry's decodes require, together: the real
 *   registry's is `DecodeRequirements`, a fake's that reads its bytes itself
 *   `never`. Left out, any registry fits, for the steps that only `detect`.
 */
type ReadRegistry<R = unknown> = {
  readonly [K in FormatKind]: Pick<
    FileImporter.Type<FormatSettings[K], K, R>,
    'format' | 'detect' | 'decode' | 'sourceFileFormat' | 'linkSourceFile' | 'linkToSourceFiles'
  >
}

/** A picked batch split by the format that claimed each file. */
interface GroupedPicks {
  /** The picks each registered format claimed, in pick order, keyed by format. */
  readonly groups: ReadonlyMap<FormatKind, readonly PickedFile.Type[]>
  /** The picks no registered format claimed, in pick order. */
  readonly unrecognized: readonly PickedFile.Type[]
}

/**
 * A picked file no registered importer's `detect` claimed — plain data, not an
 * error, since nothing ever fails with one.
 */
interface UnrecognizedFile {
  /** Distinguishes this pick from every other in the batch — the row's React key and result id. */
  readonly id: string
  /** The file's name, as the preview and the results head the row with. */
  readonly title: string
  /** The one pick, kept as a list so it reads like every other result's `files`. */
  readonly files: readonly PickedFile.Type[]
}

/** The picks each claimed format holds, in pick order, keyed by format. */
type FormatFiles = { readonly [K in FormatKind]?: readonly PickedFile.Type[] }

/**
 * A picked batch as decoded: each claimed format's review group, the files
 * it read them from, and the files no format recognised. A decoded batch
 * holds no linked records and no link targets: those are a resolved batch's
 * (`resolveMentions`).
 */
interface DecodedBatch {
  /** Each claimed format's review group, keyed by format. */
  readonly groups: ReviewGroup.Groups<FormatKind>
  /** The picks each claimed format holds: what a re-decode reads again. */
  readonly files: FormatFiles
  /** The picks no registered format claimed, in pick order. */
  readonly unrecognizedFiles: readonly UnrecognizedFile[]
}

/**
 * The format that claims a pick, by the first registered `detect` that
 * returns true, or `undefined` when none does.
 *
 * @remarks
 * The picker gates on `detect` too, but the read half re-identifies — the
 * picker is one source of picks (a server pick arrives pre-typed by the
 * format whose `isSourceFile` claimed it), and the identification is the
 * fact this module must not assume.
 */
const identifyPick = (
  registry: ReadRegistry,
  pick: PickedFile.NamedBytes
): FormatKind | undefined => FormatDetector.claiming(Object.values(registry), pick)?.format

/**
 * Split a picked batch by the format that claims each file, giving every pick
 * the id it is known by from here on.
 *
 * @param registry - The registered formats' `detect`s
 * @param picks - The batch, in pick order
 * @returns The per-format groups (pick order kept within each) and the
 *   unclaimed picks
 *
 * @remarks
 * **The one place a pick's id is minted.** It is the pick's position in the
 * whole batch and its file name, so two picks of the same name (two
 * `report.pdf`s out of two folders) stay distinct, and a settings re-decode —
 * which hands the same files back — yields the same ids, so every review key,
 * result id and unreadable row derived from one survives.
 */
const groupByFormat = (
  registry: ReadRegistry,
  picks: readonly PickedFile.NamedBytes[]
): GroupedPicks => {
  const groups = new Map<FormatKind, PickedFile.Type[]>()
  const unrecognized: PickedFile.Type[] = []
  picks.forEach((pick, index) => {
    const file: PickedFile.Type = { ...pick, id: `${index}:${pick.fileName}` }
    const kind = identifyPick(registry, file)
    if (kind === undefined) {
      unrecognized.push(file)
      return
    }
    const group = groups.get(kind)
    if (group === undefined) groups.set(kind, [file])
    else group.push(file)
  })
  return { groups, unrecognized }
}

/**
 * Run one format's batch `decode` on its files under the format's current
 * settings, and import what it decoded into the format's review group.
 *
 * @typeParam K - The one format being decoded; generic so `registry[kind]`
 *   and `settings[kind]` stay correlated (see the module remarks)
 * @param registry - The registered formats' `decode`s
 * @param settings - Every format's current settings
 * @param kind - The format to decode with
 * @param files - The files that format claimed
 * @returns The format's review group, requiring what the registry's decodes
 *   require
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- K correlates `registry[kind]` with `settings[kind]` (module remarks)
const decodeFormat = <K extends FormatKind, R>(
  registry: ReadRegistry<R>,
  settings: FormatSettings,
  kind: K,
  files: readonly PickedFile.Type[]
): Effect.Effect<ReviewGroup.Type, never, R> =>
  Effect.flatMap(registry[kind].decode(files, settings[kind]), (decoded) =>
    importDecoded(registry[kind], decoded)
  )

/** Each claimed format with its picks, in registry order. */
const claimedFiles = (
  files: FormatFiles
): readonly (readonly [FormatKind, readonly PickedFile.Type[]])[] =>
  Arr.filterMap(formatKinds, (kind) =>
    Option.map(Option.fromNullable(files[kind]), (claimed) => [kind, claimed] as const)
  )

/**
 * `files`' formats, each decoded into its review group: the groups keyed by
 * format, decoded concurrently.
 */
const decodeFormats = <R>(
  registry: ReadRegistry<R>,
  settings: FormatSettings,
  files: FormatFiles
): Effect.Effect<ReviewGroup.Groups<FormatKind>, never, R> =>
  Effect.map(
    Effect.forEach(
      claimedFiles(files),
      ([kind, claimed]) =>
        Effect.map(
          decodeFormat(registry, settings, kind, claimed),
          (group) => [kind, group] as const
        ),
      { concurrency: 'unbounded' }
    ),
    Record.fromEntries
  )

/**
 * Read a freshly picked batch: group it by format, decode every group
 * under its format's current settings, and yield a {@link DecodedBatch}
 * with one review group per claimed format plus any unrecognized files.
 *
 * @param registry - The registered formats' `detect`s and `decode`s
 * @param settings - Every format's current settings
 * @param picks - The batch, in pick order
 * @returns The batch's review groups, their files and its unrecognized
 *   files, requiring what the registry's decodes require
 *
 * @remarks
 * Formats decode concurrently. Every id and review key is built on a pick's
 * id ({@link groupByFormat}), so a settings re-decode produces the same ones
 * by construction.
 */
const readBatch = <R>(
  registry: ReadRegistry<R>,
  settings: FormatSettings,
  picks: readonly PickedFile.NamedBytes[]
): Effect.Effect<DecodedBatch, never, R> => {
  const { groups, unrecognized } = groupByFormat(registry, picks)
  const files: FormatFiles = Object.fromEntries(groups)
  return Effect.map(decodeFormats(registry, settings, files), (decoded): DecodedBatch => ({
    groups: decoded,
    files,
    unrecognizedFiles: unrecognized.map((pick): UnrecognizedFile => ({
      id: FormatDecode.makeFileId('unrecognized', pick),
      title: pick.fileName,
      files: [pick],
    })),
  }))
}

/**
 * Re-decode one format's files from the current batch under new settings,
 * leaving every other format untouched.
 *
 * @param registry - The registered formats' `decode`s
 * @param settings - Every format's settings, the changed one included
 * @param kind - The format whose settings changed
 * @param batch - The batch's current result
 * @returns The batch with that format's group replaced, requiring what the
 *   registry's decodes require; the batch itself when the format claimed
 *   nothing
 *
 * @remarks
 * Every other format's group is passed straight back, by reference, so
 * nothing else re-decodes. Every id and review key is built on a pick's id,
 * so the same files produce the same ones under any settings: the
 * reviewer's selection survives by construction.
 */
const redecodeFormat = <R>(
  registry: ReadRegistry<R>,
  settings: FormatSettings,
  kind: FormatKind,
  batch: DecodedBatch
): Effect.Effect<DecodedBatch, never, R> =>
  pipe(
    Option.fromNullable(batch.files[kind]),
    Option.match({
      onNone: () => Effect.succeed(batch),
      onSome: (files) =>
        Effect.map(decodeFormat(registry, settings, kind, files), (group): DecodedBatch => ({
          ...batch,
          groups: { ...batch.groups, [kind]: group },
        })),
    })
  )

/**
 * The formats that claimed at least one file in a batch, in registry order.
 *
 * @remarks
 * The one predicate for "did this format take part", so the preview's groups
 * and tallies and the confirm's write plans agree.
 *
 * @param batch - A decoded batch
 * @returns Every format with at least one claimed file, in {@link formatKinds} order
 */
const claimedFormats = (batch: DecodedBatch): readonly FormatKind[] =>
  claimedFiles(batch.files).map(([kind]) => kind)

export {
  type DecodedBatch,
  claimedFormats,
  decodeFormat,
  type FormatFiles,
  groupByFormat,
  type GroupedPicks,
  identifyPick,
  readBatch,
  type ReadRegistry,
  redecodeFormat,
  type UnrecognizedFile,
}
