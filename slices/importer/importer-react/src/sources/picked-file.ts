/**
 * The picker's vocabulary — `PickedFile`, its `local` / `server` source, and
 * the one spelling of a source file's `DocumentReference/<id>` reference —
 * re-exported from `importer-fundamentals`, where every format's `decode`
 * reads it. The picker sources in this directory produce it; nothing here
 * redefines it.
 *
 * @packageDocumentation
 */
export {
  LOCAL_SOURCE,
  type PickedFile,
  type PickedFileSource,
  serverSource,
  sourceFileReference,
} from 'importer-fundamentals'
