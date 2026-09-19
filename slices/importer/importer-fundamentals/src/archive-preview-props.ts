/**
 * The props contract every format's optional archive preview renders against.
 *
 * @remarks
 * Its own module rather than a member of `file-importer.ts`: it describes a
 * *component*, not the importer value, and the only things that name it are the
 * format-specific preview components and the shell's registry. It lives in this
 * package — which has no React dependency and needs none for a structural props
 * type — so that every format's React package can render against one contract
 * without any of them depending on each other.
 *
 * @packageDocumentation
 */

/**
 * The raw file's name and bytes, handed to a format-specific preview when the
 * shell opens a source file from the server list.
 */
interface ArchivePreviewProps {
  /** The source file's display name. */
  readonly fileName: string
  /** The source file's raw bytes. */
  readonly bytes: Uint8Array
}

export type { ArchivePreviewProps }
