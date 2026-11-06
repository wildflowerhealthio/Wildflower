import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Binary } from '@wildflowerhealthio/fhir-r4/resources'
import { type HttpResponseKind, UrlMatch } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Schema } from 'effect'

import * as FhirServerResponseKind from '../fhir-server-response-kind.ts'

const decode = Schema.decode(Schema.parseJson(Binary.Schema))

/** `…://host/Binary/<id>` with optional query string, no further path. */
const binaryUrl = UrlMatch.make({
  verb: ['GET'],
  segments: [UrlMatch.literal('Binary'), UrlMatch.id],
})

/**
 * A FHIR R4 `Binary` read served as a JSON `Binary` resource, `…/Binary/<id>`:
 * the one Binary, keyless (R4 gives it no identifier).
 *
 * @remarks
 * Only the JSON resource form: a read served as the raw content (an
 * `image/*` or `application/pdf` body) is no FHIR resource, and fails to
 * parse here. The HAR importer gives the Binary's entry the read's URL less
 * its query, `<root>/Binary/<id>`, as its `fullUrl`, which is what a
 * reference or an `Attachment.url` naming it is detached to.
 */
const BinaryResponseKind: HttpResponseKind.HttpResponseKind<
  DetachedResource.Detached<typeof Binary.Schema.Type>
> = FhirServerResponseKind.make({
  name: 'BinaryResponseKind',
  url: binaryUrl,
  readRecords: (body) => Effect.map(decode(body), (binary) => [binary]),
})

export { BinaryResponseKind }
