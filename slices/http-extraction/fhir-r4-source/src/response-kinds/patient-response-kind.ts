import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { type HttpResponseKind, UrlMatch } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Schema } from 'effect'

import * as FhirServerResponseKind from '../fhir-server-response-kind.ts'

const decode = Schema.decode(Schema.parseJson(Patient.Schema))

/** `…://host/Patient/<id>` with optional query string, no further path. */
const patientUrl = UrlMatch.make({
  verb: ['GET'],
  segments: [UrlMatch.literal('Patient'), UrlMatch.id],
})

/**
 * A FHIR R4 `Patient` read, `…/Patient/<id>`: the one Patient, keyless when
 * the server sent it with no id.
 */
const PatientResponseKind: HttpResponseKind.HttpResponseKind<
  DetachedResource.Detached<typeof Patient.Schema.Type>
> = FhirServerResponseKind.make({
  name: 'PatientResponseKind',
  url: patientUrl,
  readRecords: (body) => Effect.map(decode(body), (patient) => [patient]),
})

export { PatientResponseKind }
