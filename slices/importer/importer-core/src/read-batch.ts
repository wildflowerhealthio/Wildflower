import { Effect } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import { type DecodeOutcome, identify, type PickedFile } from 'importer-fundamentals'

import type { BoundFormat, FormatKind, FormatSettings } from './registry.ts'
import type { UnitReadOutcome } from './unit-read-outcome.ts'

/**
 * The read half of an import as pure functions over the registry: group a
 * picked batch by the format that claims each file, run every format's
 * batch `decode` under its current settings, fold the outcomes into
 * {@link UnitReadOutcome}s, and re-decode one format's units when its
 * settings change. No services, no writes — the shell runs these and holds
 * the result.
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

/** Mints the per-unit ids — injected so a caller (or a test) decides where identity comes from. */
type NewId = () => string

/** A picked batch split by the format that claimed each file. */
interface GroupedPicks {
  /** The picks each registered format claimed, in pick order, keyed by format. */
  readonly groups: ReadonlyMap<FormatKind, readonly PickedFile[]>
  /** The picks no registered format claimed, in pick order. */
  readonly unrecognized: readonly PickedFile[]
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
 * settings.
 *
 * @typeParam K - The one format being decoded; generic so `registry[kind]`
 *   and `settings[kind]` stay correlated (see the module remarks)
 * @param registry - The registered formats' `decode`s
 * @param settings - Every format's current settings
 * @param kind - The format to decode with
 * @param files - The files that format claimed
 * @returns The format's per-unit outcomes
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the single use is the point: `kind: K` (not `FormatKind`) is what lets `registry[kind]` and `settings[kind]` type-check against each other in the body
const decodeFormat = <K extends FormatKind>(
  registry: ReadRegistry,
  settings: FormatSettings,
  kind: K,
  files: readonly PickedFile[]
): Effect.Effect<readonly DecodeOutcome<FhirResource>[]> =>
  registry[kind].decode(files, settings[kind])

/** Tag a format's decode outcome with the format and a unit id. */
const toUnitOutcome = (
  format: FormatKind,
  id: string,
  outcome: DecodeOutcome<FhirResource>
): UnitReadOutcome =>
  outcome._tag === 'read'
    ? {
        _tag: 'read',
        id,
        title: outcome.title,
        files: outcome.files,
        format,
        decoded: outcome.decoded,
      }
    : {
        _tag: 'unreadable',
        id,
        title: outcome.title,
        files: outcome.files,
        format,
        error: outcome.error,
      }

/**
 * Read a freshly picked batch: group it by format, decode every group
 * under its format's current settings, and yield one outcome per unit —
 * every format's units in format-group order, then the unrecognized picks.
 *
 * @param registry - The registered formats' `detect`s and `decode`s
 * @param settings - Every format's current settings
 * @param picks - The batch, in pick order
 * @param newId - Mints each unit's id
 * @returns One {@link UnitReadOutcome} per unit
 *
 * @remarks
 * Formats decode concurrently; a format's own units come back in the order
 * its `decode` yields them (pick order, for a single-file format). Each
 * unit's id is minted once here and kept by {@link redecodeFormat}, so a
 * selection keyed by unit id survives a settings change.
 */
const readBatch = (
  registry: ReadRegistry,
  settings: FormatSettings,
  picks: readonly PickedFile[],
  newId: NewId
): Effect.Effect<readonly UnitReadOutcome[]> => {
  const { groups, unrecognized } = groupByFormat(registry, picks)
  const decodeGroup = ([format, files]: readonly [
    FormatKind,
    readonly PickedFile[],
  ]): Effect.Effect<readonly UnitReadOutcome[]> =>
    decodeFormat(registry, settings, format, files).pipe(
      Effect.map((outcomes) => outcomes.map((outcome) => toUnitOutcome(format, newId(), outcome)))
    )
  return Effect.forEach([...groups.entries()], decodeGroup, { concurrency: 'unbounded' }).pipe(
    Effect.map((perFormat): readonly UnitReadOutcome[] => [
      ...perFormat.flat(),
      ...unrecognized.map((pick): UnitReadOutcome => ({
        _tag: 'unrecognized',
        id: newId(),
        title: pick.fileName,
        files: [pick],
      })),
    ])
  )
}

/**
 * Re-decode one format's units from their retained files under new
 * settings, leaving every other unit untouched and in place.
 *
 * @param registry - The registered formats' `decode`s
 * @param settings - Every format's settings, the changed one included
 * @param kind - The format whose settings changed
 * @param units - The batch's current outcomes
 * @param newId - Mints an id only when a re-decode yields more units than it
 *   started with (a group format regrouping); the first unit keeps its id
 * @returns The batch with that format's units replaced
 *
 * @remarks
 * `read` and `unreadable` units of the format alike re-decode — new
 * settings could in principle read a file the old ones could not. A unit
 * that re-decodes to exactly one unit (every single-file format, always)
 * keeps its id, so the reviewer's selection keyed by it keeps applying;
 * a re-decode that yields several units keeps the id on the first.
 */
const redecodeFormat = (
  registry: ReadRegistry,
  settings: FormatSettings,
  kind: FormatKind,
  units: readonly UnitReadOutcome[],
  newId: NewId
): Effect.Effect<readonly UnitReadOutcome[]> =>
  Effect.forEach(
    units,
    (unit): Effect.Effect<readonly UnitReadOutcome[]> => {
      if (unit._tag === 'unrecognized' || unit.format !== kind) return Effect.succeed([unit])
      return decodeFormat(registry, settings, kind, unit.files).pipe(
        Effect.map((outcomes) =>
          outcomes.map((outcome, index) =>
            toUnitOutcome(kind, index === 0 ? unit.id : newId(), outcome)
          )
        )
      )
    },
    { concurrency: 'unbounded' }
  ).pipe(Effect.map((perUnit) => perUnit.flat()))

export {
  decodeFormat,
  groupByFormat,
  type GroupedPicks,
  identifyPick,
  type NewId,
  readBatch,
  type ReadRegistry,
  redecodeFormat,
}
