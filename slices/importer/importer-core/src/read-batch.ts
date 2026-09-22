import { Effect, Option, pipe } from 'effect'
import { FormatDecode, FormatDetector, type PickedFile } from 'importer-fundamentals'

import { type BoundFormat, type FormatKind, formatKinds, type FormatSettings } from './registry.ts'

/**
 * The read half of an import as pure functions over the registry: group a
 * picked batch by the format that claims each file, run every format's
 * batch `decode` under its current settings, and re-decode one format when
 * its settings change. No services, no writes — the shell runs these and
 * holds the result.
 *
 * @remarks
 * The registry is a record keyed by {@link FormatKind}, so a caller holding a
 * `kind: FormatKind` cannot index `registry[kind].decode(files, settings[kind])`
 * directly — TypeScript does not correlate the two union-indexed accesses.
 * {@link decodeFormat} closes that gap with a generic `K`: inside it `kind` is
 * one specific `K`, so `registry[kind]` is a `BoundFormat<K>` and
 * `settings[kind]` its `FormatSettings[K]`, with no per-format branch to keep
 * in step with the registry.
 *
 * The same correlation is why nothing here assembles a per-format record from
 * a `kind` variable: `{ [kind]: result }` and `{ ...batch, [kind]: result }`
 * type-check against nothing, because TypeScript widens a computed union key
 * to an index signature and drops the key's correlation with its value. The
 * one place a whole record is produced — {@link collectFormats} — names each
 * format literally, so the compiler checks every slot against its own
 * `Result<K>` and a format missing from it fails to compile.
 *
 * @packageDocumentation
 */

/**
 * The registry surface the read half needs: each format's `format` and
 * `detect` (to identify a pick) and `decode` (to read it). Not the whole
 * {@link BoundFormat}, so a test can stand up a fake registry with just
 * these fields.
 */
type ReadRegistry = {
  readonly [K in FormatKind]: Pick<BoundFormat<K>, 'format' | 'detect' | 'decode'>
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

/**
 * One decode result per registered format, each correlated with its own
 * format kind — empty when that format claimed no files.
 */
type FormatResults = {
  readonly [K in FormatKind]: FormatDecode.Result<K>
}

/**
 * The complete result of reading a picked batch: every format's
 * {@link FormatResults} slot plus the files no format recognized.
 */
type BatchDecodeResult = FormatResults & {
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
 * settings. Each result's id is deterministic, minted inside the format's
 * `decode` via `FormatDecode.makeId`.
 *
 * @typeParam K - The one format being decoded; generic so `registry[kind]`
 *   and `settings[kind]` stay correlated (see the module remarks)
 * @param registry - The registered formats' `decode`s
 * @param settings - Every format's current settings
 * @param kind - The format to decode with
 * @param files - The files that format claimed
 * @returns The format's decode result
 */
const decodeFormat = <K extends FormatKind>(
  registry: ReadRegistry,
  settings: FormatSettings,
  kind: K,
  files: readonly PickedFile.Type[]
): Effect.Effect<FormatDecode.Result<K>> => registry[kind].decode(files, settings[kind])

/**
 * Build a whole batch by running one effect per registered format,
 * concurrently.
 *
 * @remarks
 * The one place this module enumerates the registry, and the only reason it
 * does is soundness: a record assembled from a `kind` variable is checked
 * against nothing (see the module remarks), so naming every format here
 * checks each slot against its own `Result<K>` and makes a format missing
 * from the registry a compile error. {@link readBatch} and
 * {@link redecodeFormat} both come through it, so the enumeration exists
 * once rather than per caller.
 *
 * @param slot - The effect for one format, generic in `K` so each slot stays
 *   correlated with its own format
 * @param unrecognizedFiles - The picks no format claimed, passed through
 * @returns The assembled batch
 */
const collectFormats = (
  slot: <K extends FormatKind>(kind: K) => Effect.Effect<FormatDecode.Result<K>>,
  unrecognizedFiles: readonly UnrecognizedFile[]
): Effect.Effect<BatchDecodeResult> =>
  Effect.all(
    {
      har: slot('har'),
      'lifelabs-pdf': slot('lifelabs-pdf'),
      dicom: slot('dicom'),
      unrecognizedFiles: Effect.succeed(unrecognizedFiles),
    },
    { concurrency: 'unbounded' }
  )

/**
 * Read a freshly picked batch: group it by format, decode every group
 * under its format's current settings, and yield a {@link BatchDecodeResult}
 * with one `FormatDecode.Result` per format kind plus any unrecognized
 * files.
 *
 * @param registry - The registered formats' `detect`s and `decode`s
 * @param settings - Every format's current settings
 * @param picks - The batch, in pick order
 * @returns A record keyed by format kind, plus `unrecognizedFiles`
 *
 * @remarks
 * Formats decode concurrently. Each format's id is deterministic via
 * `FormatDecode.makeId`, so a settings re-decode produces the same ids
 * by construction.
 */
const readBatch = (
  registry: ReadRegistry,
  settings: FormatSettings,
  picks: readonly PickedFile.NamedBytes[]
): Effect.Effect<BatchDecodeResult> => {
  const { groups, unrecognized } = groupByFormat(registry, picks)
  return collectFormats(
    (kind) =>
      pipe(
        groups.get(kind),
        Option.fromNullable,
        Option.map((files) => decodeFormat(registry, settings, kind, files)),
        Option.getOrElse(() => Effect.succeed(FormatDecode.emptyResult(kind)))
      ),
    unrecognized.map((pick): UnrecognizedFile => ({
      id: FormatDecode.makeFileId('unrecognized', pick),
      title: pick.fileName,
      files: [pick],
    }))
  )
}

/**
 * Re-decode one format's files from the current batch under new settings,
 * leaving every other format untouched.
 *
 * @param registry - The registered formats' `decode`s
 * @param settings - Every format's settings, the changed one included
 * @param kind - The format whose settings changed
 * @param batch - The batch's current result
 * @returns The batch with that format's result replaced
 *
 * @remarks
 * Rebuilds the batch through {@link collectFormats} rather than replacing one
 * slot: every other format's slot is passed straight back, by reference, so
 * nothing else re-decodes. Each format's id is deterministic via
 * `FormatDecode.makeId`, so the same files produce the same ids under any
 * settings — the reviewer's selection survives by construction.
 */
const redecodeFormat = (
  registry: ReadRegistry,
  settings: FormatSettings,
  kind: FormatKind,
  batch: BatchDecodeResult
): Effect.Effect<BatchDecodeResult> => {
  // Read slots through FormatResults, not BatchDecodeResult: an indexed access
  // on an intersection distributes to every format's result, while the mapped
  // type alone resolves to this slot's own `Result<K>`.
  const results: FormatResults = batch
  return collectFormats(
    (slotKind) =>
      slotKind === kind
        ? decodeFormat(registry, settings, slotKind, results[slotKind].files)
        : Effect.succeed(results[slotKind]),
    batch.unrecognizedFiles
  )
}

/**
 * The formats that claimed at least one file in a batch, in registry order.
 *
 * @remarks
 * The one predicate for "did this format take part", so the preview's groups
 * and tallies and the confirm's write plans agree. A format that claimed
 * nothing has an `emptyResult` — no files, no sections, a blank `title` — so
 * treating it as a participant reports a titleless `skipped` row.
 *
 * @param batch - The batch's decode result
 * @returns Every format with at least one claimed file, in {@link formatKinds} order
 */
const claimedFormats = (batch: BatchDecodeResult): readonly FormatKind[] =>
  formatKinds.filter((kind) => batch[kind].files.length > 0)

export {
  type BatchDecodeResult,
  claimedFormats,
  decodeFormat,
  groupByFormat,
  type GroupedPicks,
  identifyPick,
  readBatch,
  type ReadRegistry,
  redecodeFormat,
  type UnrecognizedFile,
}
