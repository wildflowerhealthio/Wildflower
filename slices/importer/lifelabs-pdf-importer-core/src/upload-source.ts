import { DateTime, Effect } from 'effect'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'

import { lifeLabsPdfArchiveToDocumentReference } from './archive/lifelabs-pdf-archive-codec.ts'

/**
 * The LifeLabs PDF descriptor's `uploadSource`: mint a fresh id, encode
 * the picked bytes as a LifeLabs-PDF-archive `DocumentReference`, PUT it,
 * and return the `DocumentReference/<id>` reference every FHIR resource
 * this file writes will stamp onto `meta.source` — including the
 * `DiagnosticReport`s the dialect synthesizes, so a reader can trace the
 * report back to its raw source PDF.
 *
 * @remarks
 * Structurally identical to `har-importer-core`'s `uploadSource`, differing
 * only in the codec it invokes: the shared shape is (mint uuid, mint upload
 * instant, encode, PUT). A follow-up may lift this out into a shared
 * helper; kept independent for now to avoid a cross-slice dependency for
 * one function.
 */
const uploadSource = (picked: {
  readonly fileName: string
  readonly bytes: Uint8Array
}): Effect.Effect<string, unknown, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    const id = yield* Effect.sync(() => crypto.randomUUID())
    const uploadedAt = yield* DateTime.now
    const resource = yield* lifeLabsPdfArchiveToDocumentReference({
      id,
      fileName: picked.fileName,
      uploadedAt,
      bytes: picked.bytes,
    })
    const client = yield* FhirR4ResourcesHttpApiClient
    yield* client.DocumentReference.Update({ path: { id }, payload: { ...resource, id } })
    return `DocumentReference/${id}`
  })

export { uploadSource }
