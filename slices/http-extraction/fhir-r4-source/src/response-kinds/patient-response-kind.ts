import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { HttpResponseKind, UrlMatch } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Schema } from 'effect'

import { extractJson } from '../extract-json.ts'
import { detachUnderFhirRoot, recognizeFhirRoot } from '../recognize-fhir-root.ts'

const decode = Schema.decode(Schema.parseJson(Patient.Schema))

/** `…://host/Patient/<id>` with optional query string, no further path. */
const patientUrl = UrlMatch.make({
  verb: ['GET'],
  segments: [UrlMatch.literal('Patient'), UrlMatch.id],
})

/**
 * Entity for a single FHIR R4 `Patient` resource fetched at
 * `…/Patient/:id?…`. The response body the handler captures is either
 * the raw JSON (XHR intercept) or the mobile WebView's HTML JSON-viewer
 * wrapper around it; {@link extractJson} normalizes both. On a successful
 * decode it emits the resource, detached under the server's root, as a
 * single-element array, and none for a Patient the server sent with no id;
 * `parse` never navigates.
 */
const PatientResponseKind: HttpResponseKind.HttpResponseKind<DetachedResource.Type> =
  HttpResponseKind.make({
    name: 'PatientResponseKind',
    tryRecognize: recognizeFhirRoot(patientUrl),
    parse: detachUnderFhirRoot(patientUrl)((response) =>
      Effect.map(decode(extractJson(response.text())), (patient) =>
        patient.id === null ? [] : [patient]
      )
    ),
  })

export { PatientResponseKind }
