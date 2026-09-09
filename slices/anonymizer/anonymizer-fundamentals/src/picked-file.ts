/**
 * The one value a picker produces: a file's name and its raw bytes.
 *
 * @remarks
 * Bytes, not text — a format decides its own decoding (HAR reads UTF-8 JSON, a
 * PDF reads binary), so the picker stays format-blind. Structural on purpose:
 * a browser `File` is adapted into one of these at the picker, and a test
 * builds one from a literal without constructing a `File`.
 *
 * @packageDocumentation
 */

/** A picked file, as name plus raw bytes. */
interface PickedFile {
  /** The file's own name, extension included (`report.har`). */
  readonly fileName: string
  /** The file's raw contents. */
  readonly bytes: Uint8Array
}

export type { PickedFile }
