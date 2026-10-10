import {
  useIsMutating,
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import {
  type BatchEntryOutcome,
  persistBatchBundleOrFail,
} from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'

import { liftingKeyOf, type LiftingSession } from './lifting-session.ts'

/**
 * A write of lifting resources: one batch `Bundle` through
 * `persistBatchBundleOrFail`, failing unless every entry was accepted.
 *
 * @param session - The launch it writes through
 * @param writeName - What it writes, the last segment of its mutation key
 *
 * @remarks
 * Once it settles — failed or not, since a batch's entries land independently
 * and a partly rejected write still changed the record — it refetches the
 * lifter's record and stays pending until the refetch lands, so no screen
 * offers a control over what the server no longer holds. There are no
 * optimistic cache edits. A retry is the caller's to make with the same ids.
 */
const useLiftingWrite = (
  session: LiftingSession,
  writeName: string
): UseMutationResult<readonly BatchEntryOutcome[], Error, readonly FhirResource[]> => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: [...liftingKeyOf(session.patientId), writeName],
    mutationFn: (resources: readonly FhirResource[]) =>
      session.runAuthed(persistBatchBundleOrFail(resources)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: liftingKeyOf(session.patientId) }),
  })
}

/** Whether any lifting write for the lifter is in flight: every screen's controls wait on it. */
const useLiftingWriting = (session: LiftingSession): boolean =>
  useIsMutating({ mutationKey: liftingKeyOf(session.patientId) }) > 0

export { useLiftingWrite, useLiftingWriting }
