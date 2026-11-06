import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { DocumentReference } from '@wildflowerhealthio/fhir-r4/resources'
import { type HttpResponseKind, UrlMatch } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Schema } from 'effect'

import * as FhirServerResponseKind from '../fhir-server-response-kind.ts'

const decode = Schema.decode(Schema.parseJson(DocumentReference.Schema))

/** `…://host/DocumentReference/<id>` with optional query string, no further path. */
const documentReferenceUrl = UrlMatch.make({
  verb: ['GET'],
  segments: [UrlMatch.literal('DocumentReference'), UrlMatch.id],
})

/**
 * A FHIR R4 `DocumentReference` read, `…/DocumentReference/<id>`: the one
 * DocumentReference, its attachments' `Binary/<id>` URLs detached to the
 * server's absolute URLs for them.
 */
const DocumentReferenceResponseKind: HttpResponseKind.HttpResponseKind<
  DetachedResource.Detached<typeof DocumentReference.Schema.Type>
> = FhirServerResponseKind.make({
  name: 'DocumentReferenceResponseKind',
  url: documentReferenceUrl,
  readRecords: (body) => Effect.map(decode(body), (document) => [document]),
})

export { DocumentReferenceResponseKind }
