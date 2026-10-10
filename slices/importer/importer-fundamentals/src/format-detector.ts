/**
 * The detection seam: what it takes to claim a picked file as one format's,
 * and the search that picks the winner.
 *
 * @remarks
 * Detection is the one thing several callers need from a format without
 * needing the format. The picker runs it to reject a file next to the control
 * the user just used; `importer-core`'s `readBatch` runs it again to group a
 * batch. Neither reads a `decode`, a `defaultSettings` or a source-file codec,
 * and neither should have to name the settings type of a format it is only
 * sniffing — so the seam is this two-field structural type rather than a
 * widened {@link FileImporter.Type}.
 *
 * A `FileImporter.Type` satisfies {@link Type} structurally, so the registry's
 * values pass straight to {@link claiming} with no adapter, and
 * {@link claiming} returns the caller's own element type rather than this one.
 *
 * @packageDocumentation
 */

import type * as PickedFile from './picked-file.ts'

/**
 * Something that can claim a picked file as its format's: a tag to name what
 * claimed it, and the cheap syntactic check that decides.
 *
 * @remarks
 * `detect` is an extension or magic-byte sniff, never a parse — it runs on
 * every detector for every file of every drop, and the real parse is the
 * winning format's `decode` one step downstream.
 */
interface Type {
  /** The format tag reported for a file this detector claims. */
  readonly format: string
  /** Whether this detector claims the file, by its leading bytes or its name. */
  readonly detect: (fileBytes: Uint8Array, fileName: string) => boolean
}

/**
 * The first detector whose `detect` claims the file.
 *
 * @typeParam TDetector - The caller's own detector type, returned as given so
 *   a registry entry comes back whole rather than narrowed to {@link Type}
 * @param detectors - The detectors, in priority order — the registry's own key
 *   order, which is what `detect` priority means
 * @param file - The file's name and bytes
 * @returns The claiming detector, or `undefined` when none claims it
 */
const claiming = <TDetector extends Type>(
  detectors: readonly TDetector[],
  file: PickedFile.NamedBytes
): TDetector | undefined => detectors.find((detector) => detector.detect(file.bytes, file.fileName))

export { claiming }
export type { Type }
