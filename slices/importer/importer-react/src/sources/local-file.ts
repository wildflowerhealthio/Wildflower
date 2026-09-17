import { Effect } from 'effect'
import { identify, type FileImporterDescriptor } from 'importer-fundamentals'

import { PickedFileSource, type PickedFile } from './picked-file.ts'

/**
 * Reading a file the user dropped or chose, and rejecting one that no
 * registered format's `detect` claims — before it becomes the importer's
 * problem.
 *
 * @remarks
 * The gate is syntactic: each registered format's cheap `detect` (extension
 * or magic bytes) is tried; the first that claims the file wins. The full
 * parse still happens in that format's `decode`, one step downstream — so a
 * file the picker accepts is one a decode will *attempt*, and a rejection
 * lands next to the control the user just used rather than surfacing three
 * steps later. This module never imports the format cores; it takes the
 * descriptor shapes as data.
 *
 * @packageDocumentation
 */

/**
 * The rejection notice shown when no registered format claims the picked
 * bytes.
 *
 * @remarks
 * Extension + magic-byte sniffs are what the shell exposes to the user, so
 * the notice speaks in those terms — a file whose extension and byte header
 * do not match any registered format cannot be decoded and needs picking
 * again.
 */
const REJECTION_MESSAGE =
  "That file's format is not one the importer recognizes. Pick a `.har` capture or a LifeLabs `.pdf` report."

/**
 * The minimal surface {@link acceptLocalFile} reads off a file.
 *
 * @remarks
 * Structural rather than the DOM `File` type: the function needs only a
 * name and an `arrayBuffer` to read the bytes; stating that keeps it
 * testable without constructing a `File` or a `DataTransfer`. A real `File`
 * satisfies it.
 */
interface ReadableFile {
  /** The file's name, carried onto the {@link PickedFile}. */
  readonly name: string
  /**
   * The file's contents as bytes, the way `File.arrayBuffer()` reads them.
   * A `Uint8Array` view over the buffer is what {@link acceptLocalFile}
   * yields.
   */
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * One rejected file, its name and the reason it was not accepted.
 */
interface RejectedFile {
  readonly name: string
  readonly message: string
}

/** The rejection payload for a file no descriptor's `detect` claims. */
const unrecognizedRejection = (file: ReadableFile): RejectedFile => ({
  name: file.name,
  message: REJECTION_MESSAGE,
})

/** Descriptors carry only `detect` through this gate. */
type IdentifiableDescriptor = Pick<FileImporterDescriptor<string, never, never>, 'detect'>

/**
 * Reads a local file's bytes and rejects it if no registered descriptor's
 * `detect` claims them.
 *
 * @param descriptors - The registered descriptors, in registry priority order
 * @param file - The dropped or chosen file
 * @returns A lazy `Effect` that yields the accepted {@link PickedFile} carrying
 *   a `local` source, or fails with the reason the file was rejected
 *
 * @remarks
 * Validation is syntactic — {@link identify} runs each descriptor's `detect`
 * against the bytes and the file name — so a full parse never runs at the
 * picker. That is what makes the gate cheap to run on every drop. The bytes
 * are wrapped as `new Uint8Array(buffer)` so downstream consumers hold a
 * concrete view rather than a `SharedArrayBuffer`-compatible one.
 */
const acceptLocalFile = (
  descriptors: readonly IdentifiableDescriptor[],
  file: ReadableFile
): Effect.Effect<PickedFile, string> =>
  Effect.promise(() => file.arrayBuffer()).pipe(
    Effect.flatMap((buffer) => {
      const bytes = new Uint8Array(buffer)
      const claim = identify(descriptors, { fileName: file.name, bytes })
      if (claim === undefined) return Effect.fail(REJECTION_MESSAGE)
      return Effect.succeed<PickedFile>({
        fileName: file.name,
        bytes,
        source: PickedFileSource.local,
      })
    })
  )

export {
  acceptLocalFile,
  type IdentifiableDescriptor,
  type ReadableFile,
  REJECTION_MESSAGE,
  type RejectedFile,
  unrecognizedRejection,
}
