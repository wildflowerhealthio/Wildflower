import { ParseResult, Schema } from 'effect'

import { makeCloneWith } from 'kitchen-sink/schema'

import { Code, Reference, Resource } from '../../data-types/index.ts'
import type { ResourceEncoded } from '../../data-types/index.ts'

const DomainType = 'Binary' as const
type DomainType = typeof DomainType

// --- Binary ---

const fields = {
  /**
   * MimeType of the binary content represented as a standard MimeType (BCP 13).
   */
  contentType: Code,
  /**
   * The actual content, base64 encoded.
   */
  data: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * Identifies another resource to use as proxy when enforcing access control
   * on the Binary resource.
   */
  securityContext: Schema.UndefinedOr(Schema.suspend(() => Reference)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
} as const satisfies Schema.Struct.Fields

const BinaryResource = Resource(DomainType)

/** Encoded (wire-format) shape of a {@link Binary}. */
export interface BinaryEncoded
  extends Schema.Struct.Encoded<typeof fields>, ResourceEncoded<DomainType> {}

/**
 * A resource that represents the data of a single raw artifact as digital
 * content accessible in its native format. A Binary resource can contain
 * any content, whether text, image, pdf, zip archive, etc.
 */
export class Binary extends BinaryResource.extend<Binary>(DomainType)(fields) {
  static readonly ResourceType = BinaryResource.ResourceType
  static readonly IdSchema = BinaryResource.IdSchema
  /** No search parameters configured for this resource. */
  static readonly SearchSchema = {}
  readonly cloneWith = makeCloneWith(Binary, this)

  static get WithId(): typeof BinaryWithId {
    return BinaryWithId
  }
}

class BinaryWithId extends Binary.transformOrFail<BinaryWithId>('BinaryWithId')(
  {},
  {
    decode(input) {
      if (input.id !== undefined) {
        return ParseResult.succeed(input)
      }
      return ParseResult.fail(
        new ParseResult.Type(Binary.IdSchema.ast, input.id, 'BinaryWithId requires an id')
      )
    },
    encode: ParseResult.succeed,
  }
) {
  declare readonly id: Schema.Schema.Type<typeof BinaryResource.IdSchema>
  override readonly cloneWith = makeCloneWith(BinaryWithId, this)
}
