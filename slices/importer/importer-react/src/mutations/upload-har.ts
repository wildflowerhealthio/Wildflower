import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { DateTime, Effect } from 'effect'
import { useRunAuthed } from 'fhir-r4-react'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { harArchiveToDocumentReference, type HarArchive } from 'har-importer-core/archive'

import { HAR_ARCHIVES_QUERY_KEY } from '../queries/keys.ts'

/**
 * Uploading a local HAR to the device's own FHIR server as an archive
 * `DocumentReference`, and invalidating the server list so the new archive
 * appears.
 *
 * @remarks
 * Every upload is a fresh document: the id is a uuid minted per call, not a
 * derivation over the bytes, so the same file uploaded twice becomes two
 * documents rather than one silently overwriting the other. That is the archive
 * codec's contract — dedupe stays *detectable* through the attachment's `hash`
 * and `size` without being forced — and this hook is where the fresh id is
 * minted. The encoding, including the hash, is `web-trace-core`'s
 * `harArchiveToDocumentReference`; nothing here re-derives it.
 *
 * @packageDocumentation
 */

/** What one upload needs: the file's name and its bytes, verbatim. */
interface UploadHarInput {
  /** The file's name, stored as the archive's title. */
  readonly fileName: string
  /**
   * The file's bytes, exactly as they were read.
   *
   * @remarks
   * Bytes rather than text: the archive codec stores the file verbatim so a
   * truncated or mis-encoded upload is preserved rather than mangled and the
   * attachment `hash` means something. A caller holding a `PickedHar`'s text
   * encodes it (`new TextEncoder().encode(text)`) at the call site.
   */
  readonly bytes: Uint8Array
}

/**
 * The mutation that uploads a HAR archive and refreshes the server list.
 *
 * @returns A TanStack mutation whose `mutateAsync` resolves to the new archive's
 *   logical id
 *
 * @remarks
 * The id is minted inside the effect with `crypto.randomUUID()` and used both as
 * the resource's own id and as the `Update` path, so the PUT preserves the
 * client-minted id rather than letting the server assign one — which is what
 * keeps two uploads of the same bytes distinct. On success the archive list
 * query is invalidated under {@link HAR_ARCHIVES_QUERY_KEY}, so the just-uploaded
 * archive shows up without a manual refresh.
 */
const useUploadHar = (): UseMutationResult<string, Error, UploadHarInput> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ fileName, bytes }: UploadHarInput): Promise<string> =>
      runAuthed(
        Effect.gen(function* () {
          const id = yield* Effect.sync(() => crypto.randomUUID())
          const uploadedAt = yield* DateTime.now
          const archive: HarArchive = { id, fileName, uploadedAt, bytes }
          const resource = yield* harArchiveToDocumentReference(archive)
          const client = yield* FhirR4ResourcesHttpApiClient
          yield* client.DocumentReference.Update({ path: { id }, payload: { ...resource, id } })
          return id
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: HAR_ARCHIVES_QUERY_KEY })
    },
  })
}

export { type UploadHarInput, useUploadHar }
