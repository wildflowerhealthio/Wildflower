import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Binary } from '@wildflowerhealthio/fhir-r4/resources'
import { type HttpResponseKind, UrlMatch } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Either, Schema } from 'effect'

import * as FhirServerResponseKind from '../fhir-server-response-kind.ts'

const parseJson = Schema.decodeEither(Schema.parseJson())
const decodeBinary = Schema.decodeUnknown(Binary.Schema)

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
 * The body is parsed as JSON once. A body that is no JSON at all is the
 * Binary served as its raw content (an `application/pdf` body, say; `image/*`
 * ones never reach a kind), no FHIR resource, so it reads as no record,
 * counted with `Effect.logInfo`, rather than a parse failure. JSON that is no
 * `Binary` still fails. The HAR importer gives the Binary the read's URL less
 * its query, `<root>/Binary/<id>`, as its source URL, which is what a
 * reference or an `Attachment.url` naming it is detached to.
 */
const BinaryResponseKind: HttpResponseKind.HttpResponseKind<
  DetachedResource.Detached<typeof Binary.Schema.Type>
> = FhirServerResponseKind.make({
  name: 'BinaryResponseKind',
  url: binaryUrl,
  readRecords: (body) =>
    Either.match(parseJson(body), {
      onLeft: () =>
        Effect.as(
          Effect.logInfo('BinaryResponseKind: a Binary served as its raw content holds no record'),
          []
        ),
      onRight: (json) => Effect.map(decodeBinary(json), (binary) => [binary]),
    }),
})

export { BinaryResponseKind }
