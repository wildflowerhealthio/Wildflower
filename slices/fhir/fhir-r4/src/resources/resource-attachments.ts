/**
 * Every `Attachment` a decoded resource carries, at any depth: found by
 * `fhir-r4`'s own `Attachment` schema rather than a list of field names, so
 * an attachment anywhere in a resource is reached.
 *
 * @remarks
 * An `Attachment.url` is a plain `url`, not a `Reference`, so
 * `ResourceReferences` never reaches it; but it can name a record all the
 * same, as a `DocumentReference` names the `Binary` holding its document by
 * `Binary/<id>`.
 *
 * @packageDocumentation
 */

import { Schema } from 'effect'

import * as Attachment from '../data-types/complex/attachment.ts'
import type { FhirResource } from './fhir-resource.ts'
import { mapTargets } from './resource-walk.ts'

type AttachmentType = typeof Attachment.Schema.Type

const isAttachmentSchema = Schema.is(Schema.typeSchema(Attachment.Schema))

/**
 * Whether a decoded record is an `Attachment`, as `fhir-r4`'s schema decides.
 * The key test only spares the schema check on the records that cannot be one.
 */
const isAttachment = (record: object): record is AttachmentType =>
  'url' in record && 'contentType' in record && isAttachmentSchema(record)

/**
 * `resource` with `rewrite` applied to the `url` of every `Attachment` it
 * carries, at any depth; an attachment with no `url` is left as it is.
 *
 * @remarks
 * Walks as `ResourceReferences.mapReferences` does, so the result has
 * `resource`'s own shape, and a resource nothing changed in comes back as
 * itself. The type system cannot follow a walk over every field, hence the
 * one assertion.
 */
const mapUrls = <TResource extends FhirResource>(
  resource: TResource,
  rewrite: (url: string) => string
): TResource =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the walk keeps the shape; see @remarks
  mapTargets(resource, '', isAttachment, (attachment) => {
    if (attachment.url === null) return attachment
    const url = rewrite(attachment.url)
    return url === attachment.url ? attachment : { ...attachment, url }
  }) as TResource

export { mapUrls }
