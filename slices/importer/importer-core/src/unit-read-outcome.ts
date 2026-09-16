import type { ParseResult } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import type { DecodedFile, PickedFile } from 'importer-fundamentals'

import type { FormatKind } from './registry.ts'

/**
 * What one unit of a picked batch read to: decoded sections under a format
 * tag, the format's `ParseError` for a unit it could not read, or a file no
 * registered format claimed. The value the review, the settings form, and
 * the confirm all dispatch on.
 *
 * @packageDocumentation
 */

/**
 * A unit read into sections, for one specific `K`. Default `K = FormatKind`
 * gives the discriminated union across every registered format.
 *
 * @remarks
 * `id` is a per-unit stable identity for a React `key` and for the
 * reviewer's selection map, since two units in a batch can share a title;
 * it survives a settings re-decode, so per-resource selections keyed by unit
 * id keep applying. `files` is what the unit was decoded from — one file for
 * a single-file format, several for a group format. `decoded` carries the
 * format's sections and notes with any source-file `DocumentReference` the
 * format minted already among the sections; the review is a pure
 * per-resource selection over them, so there is no further per-format
 * review state.
 */
type ReadUnit<K extends FormatKind> = {
  readonly [Kind in K]: {
    readonly _tag: 'read'
    readonly id: string
    readonly title: string
    readonly files: readonly PickedFile[]
    readonly format: Kind
    readonly decoded: DecodedFile<FhirResource>
  }
}[K]

/**
 * A unit whose format was identified but whose decode rejected the bytes —
 * the format's own `ParseError`, under its tag. Distributed over `K` the
 * same way {@link ReadUnit} is.
 */
type UnreadableUnit<K extends FormatKind> = {
  readonly [Kind in K]: {
    readonly _tag: 'unreadable'
    readonly id: string
    readonly title: string
    readonly files: readonly PickedFile[]
    readonly format: Kind
    readonly error: ParseResult.ParseError
  }
}[K]

/** A picked file no registered descriptor's `detect` claimed. No format, no sections. */
interface UnrecognizedFile {
  readonly _tag: 'unrecognized'
  readonly id: string
  readonly title: string
  readonly files: readonly PickedFile[]
}

/**
 * One unit's read outcome, tagged with the format that claimed it so the
 * settings form, the confirm, and the preview all dispatch on it.
 */
type UnitReadOutcome = ReadUnit<FormatKind> | UnreadableUnit<FormatKind> | UnrecognizedFile

export type { ReadUnit, UnitReadOutcome, UnreadableUnit, UnrecognizedFile }
