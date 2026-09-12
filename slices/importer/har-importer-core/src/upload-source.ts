import { DateTime, Effect } from 'effect'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'

import { harArchiveToDocumentReference } from './archive/har-archive-codec.ts'

/**
 * The HAR descriptor's `uploadSource`: mint a fresh id, encode the picked
 * bytes as a HAR-archive `DocumentReference`, PUT it, and return the
 * `DocumentReference/<id>` reference every FHIR resource this file writes
 * will stamp onto `meta.source`.
 *
 * @remarks
 * The id is minted with `crypto.randomUUID()` and used both as the
 * resource id and as the `Update` path, so the PUT preserves the
 * client-minted id — two uploads of the same bytes are two documents,
 * detectable by hash+size but never silently merged. Nothing here mutates
 * anything else; the shell can call this for one file and invalidate the
 * server list once at end-of-batch.
 */
const uploadSource = (picked: {
  readonly fileName: string
  readonly bytes: Uint8Array
}): Effect.Effect<string, unknown, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    const id = yield* Effect.sync(() => crypto.randomUUID())
    const uploadedAt = yield* DateTime.now
    const resource = yield* harArchiveToDocumentReference({
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
