/**
 * The batch decode every format binding ends up exposing: files and settings
 * in, one `FormatDecode.Result` out, never failing.
 *
 * @remarks
 * Two spellings of one signature, differing only in what is still to be
 * provided — {@link WithContext} while a format's source-file constants are
 * outstanding, {@link Type} once `FileImporter.make` has bound them.
 *
 * Deliberately just the contract: no constructor lives here, because how a
 * format gets from its files to a result is the format's own business.
 * `per-file-decode-function.ts` is the one constructor the slice ships, for
 * formats whose files decode independently; a format whose files must be read
 * together gets a sibling module rather than a widened version of that one.
 *
 * @packageDocumentation
 */

import type { Effect } from 'effect'
import type * as FormatDecode from './format-decode.ts'
import type * as PickedFile from './picked-file.ts'

/**
 * The batch decode the shell runs: every file of one format, under that
 * format's settings, never failing and requiring nothing.
 *
 * @remarks
 * This is the bound end of {@link WithContext} — what a `FileImporter` exposes,
 * once `FileImporter.make` has discharged the source-file context.
 * `PerFileDecodeFunction.make` returns the unbound end, and is one constructor
 * of this type rather than the only one.
 */
type Type<in TSettings, TFormat extends string> = WithContext<TSettings, TFormat, never>

/**
 * A batch decode with its requirement still spelled: `never` once
 * `FileImporter.make` has bound it, `SourceFileCodec.FormatContext` while the
 * format's coding constants are still to be provided.
 */
type WithContext<in TSettings, TFormat extends string, R> = (
  files: readonly PickedFile.Type[],
  settings: TSettings
) => Effect.Effect<FormatDecode.Result<TFormat>, never, R>

export type { Type, WithContext }
