import { Data, Effect, Either } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import {
  identify,
  type PickedFile,
  type ReadUnit,
  type UnreadableUnit,
  unitId,
} from 'importer-fundamentals'

import type { BoundFormat, FormatKind, FormatSettings } from './registry.ts'

/**
 * The read half of an import as pure functions over the registry: group a
 * picked batch by the format that claims each file, run every format's
 * batch `decode` under its current settings, and re-decode one format's
 * units when its settings change. No services, no writes — the shell runs
 * these and holds the result.
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
 * @packageDocumentation
 */

/**
 * The registry surface the read half needs: each format's `detect` (to
 * identify a pick) and `decode` (to read it). Not the whole
 * {@link BoundFormat}, so a test can stand up a fake registry with just
 * these fields.
 */
type ReadRegistry = {
  readonly [K in FormatKind]: Pick<BoundFormat<K>, 'format' | 'detect' | 'decode'>
}

/** A picked batch split by the format that claimed each file. */
interface GroupedPicks {
  /** The picks each registered format claimed, in pick order, keyed by format. */
  readonly groups: ReadonlyMap<FormatKind, readonly PickedFile[]>
  /** The picks no registered format claimed, in pick order. */
  readonly unrecognized: readonly PickedFile[]
}

/** A picked file no registered descriptor's `detect` claimed. */
class UnrecognizedFile extends Data.TaggedError('UnrecognizedFile')<{
  readonly id: string
  readonly title: string
  readonly files: readonly PickedFile[]
  readonly format?: undefined
}> {}

/** The batch outcome for one unit: a successfully decoded `ReadUnit` or a failure. */
type BatchEntry = Either.Either<
  ReadUnit<FhirResource, FormatKind>,
  UnreadableUnit<FormatKind> | UnrecognizedFile
>

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
const identifyPick = (registry: ReadRegistry, pick: PickedFile): FormatKind | undefined =>
  identify(Object.values(registry), pick)?.format

/**
 * Split a picked batch by the format that claims each file.
 *
 * @param registry - The registered formats' `detect`s
 * @param picks - The batch, in pick order
 * @returns The per-format groups (pick order kept within each) and the
 *   unclaimed picks
 */
const groupByFormat = (registry: ReadRegistry, picks: readonly PickedFile[]): GroupedPicks => {
  const groups = new Map<FormatKind, PickedFile[]>()
  const unrecognized: PickedFile[] = []
  for (const pick of picks) {
    const kind = identifyPick(registry, pick)
    if (kind === undefined) {
      unrecognized.push(pick)
      continue
    }
    const group = groups.get(kind)
    if (group === undefined) groups.set(kind, [pick])
    else group.push(pick)
  }
  return { groups, unrecognized }
}

/**
 * Run one format's batch `decode` on its files under the format's current
 * settings. Each unit's id and format tag are deterministic, minted inside
 * the format's `decode` via {@link unitId}.
 *
 * @typeParam K - The one format being decoded; generic so `registry[kind]`
 *   and `settings[kind]` stay correlated (see the module remarks)
 * @param registry - The registered formats' `decode`s
 * @param settings - Every format's current settings
 * @param kind - The format to decode with
 * @param files - The files that format claimed
 * @returns The format's per-unit outcomes
 */
const decodeFormat = <K extends FormatKind>(
  registry: ReadRegistry,
  settings: FormatSettings,
  kind: K,
  files: readonly PickedFile[]
): Effect.Effect<readonly Either.Either<ReadUnit<FhirResource, K>, UnreadableUnit<K>>[]> =>
  registry[kind].decode(files, settings[kind])

/**
 * Read a freshly picked batch: group it by format, decode every group
 * under its format's current settings, and yield one outcome per unit —
 * every format's units in format-group order, then the unrecognized picks.
 *
 * @param registry - The registered formats' `detect`s and `decode`s
 * @param settings - Every format's current settings
 * @param picks - The batch, in pick order
 * @returns One `Either` per unit: `Right` for decoded, `Left` for failures
 *
 * @remarks
 * Formats decode concurrently; a format's own units come back in the order
 * its `decode` yields them (pick order, for a single-file format). Each
 * unit's id is deterministic via {@link unitId}, so a settings re-decode
 * produces the same ids by construction.
 */
const readBatch = (
  registry: ReadRegistry,
  settings: FormatSettings,
  picks: readonly PickedFile[]
): Effect.Effect<readonly BatchEntry[]> => {
  const { groups, unrecognized } = groupByFormat(registry, picks)
  const decodeGroup = ([format, files]: readonly [
    FormatKind,
    readonly PickedFile[],
  ]): Effect.Effect<readonly BatchEntry[]> => decodeFormat(registry, settings, format, files)
  return Effect.forEach([...groups.entries()], decodeGroup, { concurrency: 'unbounded' }).pipe(
    Effect.map((perFormat): readonly BatchEntry[] => [
      ...perFormat.flat(),
      ...unrecognized.map((pick): BatchEntry =>
        Either.left(
          new UnrecognizedFile({
            id: unitId('unrecognized', [pick]),
            title: pick.fileName,
            files: [pick],
          })
        )
      ),
    ])
  )
}

/** Extract the id from either side of a batch entry. */
const entryId = (entry: BatchEntry): string => Either.merge(entry).id

/** Extract the format from either side (undefined for unrecognized). */
const entryFormat = (entry: BatchEntry): FormatKind | undefined => Either.merge(entry).format

/**
 * Re-decode one format's units from their retained files under new
 * settings, leaving every other unit untouched and in place.
 *
 * @param registry - The registered formats' `decode`s
 * @param settings - Every format's settings, the changed one included
 * @param kind - The format whose settings changed
 * @param units - The batch's current outcomes
 * @returns The batch with that format's units replaced
 *
 * @remarks
 * Both read and unreadable units of the format re-decode — new settings
 * could in principle read a file the old ones could not. Each unit's id
 * is deterministic via {@link unitId}, so the same files produce the same
 * ids under any settings — the reviewer's selection survives by
 * construction.
 */
const redecodeFormat = (
  registry: ReadRegistry,
  settings: FormatSettings,
  kind: FormatKind,
  units: readonly BatchEntry[]
): Effect.Effect<readonly BatchEntry[]> =>
  Effect.forEach(
    units,
    (unit): Effect.Effect<readonly BatchEntry[]> => {
      if (entryFormat(unit) !== kind) return Effect.succeed([unit])
      const { files } = Either.merge(unit)
      return decodeFormat(registry, settings, kind, files)
    },
    { concurrency: 'unbounded' }
  ).pipe(Effect.map((perUnit) => perUnit.flat()))

export {
  type BatchEntry,
  decodeFormat,
  entryFormat,
  entryId,
  groupByFormat,
  type GroupedPicks,
  identifyPick,
  readBatch,
  type ReadRegistry,
  redecodeFormat,
  UnrecognizedFile,
}
