/**
 * The picker's vocabulary — `PickedFile`, its `local` / `server` source, and
 * the source-file reference type — re-exported from `importer-fundamentals`,
 * where every format's `decode` reads it. The picker sources in this directory
 * produce it; nothing here redefines it.
 *
 * @packageDocumentation
 */
export { type PickedFile, PickedFileSource, SourceFile } from 'importer-fundamentals'
