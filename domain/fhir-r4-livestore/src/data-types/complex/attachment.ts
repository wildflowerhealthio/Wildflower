import { Schema } from 'effect'

import { Element } from '../base/element.ts'
import type { ElementEncoded } from '../base/element.ts'
import { Code } from './code.ts'

const ResourceType = 'Attachment'

const fields = {
  /**
   * Identifies the type of the data in the attachment and allows a method to be chosen to interpret or render the data. Includes mime type parameters such as charset where appropriate.
   * Per FHIR R4 spec: if data is present, contentType SHALL be populated.
   */
  contentType: Schema.UndefinedOr(Code).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * The human language of the content. The value can be any valid value according to BCP 47.
   */
  language: Schema.UndefinedOr(Code).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * The actual data of the attachment - a sequence of bytes, base64 encoded.
   */
  data: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  /** A location where the data can be accessed.
   *
   * @remarks Renamed from FHIR R4's `url` to avoid collision with the
   * branded persistence URL on Element. */
  dataUrl: Schema.UndefinedOr(Schema.String).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  /**
   * The number of bytes of data that make up this attachment (before base64 encoding, if that is done).
   */
  size: Schema.UndefinedOr(Schema.Int).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * The calculated hash of the data using SHA-1. Represented using base64.
   */
  hash: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * A label or set of text to display in place of the data.
   */
  title: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * The date that the attachment was first created.
   */
  creation: Schema.UndefinedOr(Schema.DateTimeUtc).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
} as const satisfies Schema.Struct.Fields

/** Encoded (wire-format) shape of an {@link Attachment}. */
export interface AttachmentEncoded
  extends Schema.Struct.Encoded<typeof fields>, ElementEncoded<typeof ResourceType> {}

const AttachmentElement = Element(ResourceType)
/**
 * For identifying specific representations or attachments.
 * This data type is used for all attachments including images, documents, etc.
 * Note: Per FHIR spec, if data is present, contentType SHALL be populated.
 */
export class Attachment extends AttachmentElement.extend<Attachment>(ResourceType)(fields) {
  static readonly ResourceType = AttachmentElement.ResourceType
  static readonly IdSchema = AttachmentElement.IdSchema
}
