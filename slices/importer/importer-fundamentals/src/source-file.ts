/**
 * The `SourceFile` namespace: everything a format needs to mint, list, link,
 * and encode its source-file `DocumentReference`.
 *
 * @remarks
 * Re-exports from `source-file-review.ts` (the decode-time composition
 * helpers) and `source-file-codec.ts` (the FHIR encoding) under one
 * namespace. The separation on disk keeps the codec's schema work apart from
 * the decode-time wiring; consumers import `SourceFile.*` through the
 * barrel and don't see the split.
 *
 * @packageDocumentation
 */

export {
  type DecodeOne,
  type Options,
  type PerFileDecodeOptions,
  type Ref,
  type Resolved,
  SECTION_TITLE,
  key,
  perFileDecode,
  resolve,
  withSections,
} from './source-file-review.ts'

export {
  type SourceFile as Type,
  type SourceFileCodec as Codec,
  type SourceFileConfig as Config,
  type SourceFileWireParams as WireParams,
  sourceFileCodec as codec,
} from './source-file-codec.ts'
