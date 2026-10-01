import {
  useIsMutating,
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import type { RunAuthed } from 'fhir-r4-react'
import { type BatchEntryOutcome, persistBatchBundleOrFail } from 'fhir-r4/clients'
import { IdentifierAndReference } from 'fhir-r4/data-types'
import type { FhirResource } from 'fhir-r4/resources'

import type { SmartClient } from './smart-client.ts'

/** Everything a lifting screen reads and writes through: one launch, for one lifter. */
interface LiftingSession {
  /** The SMART client every search is issued through. */
  readonly client: SmartClient
  /** The launch's patient: every search is scoped to them. */
  readonly patientId: string
  /** Runs a write against the FHIR server the handshake named, with the granted token. */
  readonly runAuthed: RunAuthed
}

/** The lifter as every resource written names them: a reference to the launch's patient. */
const subjectOf = (session: LiftingSession): IdentifierAndReference.ReferenceType =>
  IdentifierAndReference.referenceTo({ resourceType: 'Patient', id: session.patientId })

/**
 * The key every lifting query and write of one lifter sits under, so one
 * invalidation refetches the whole record and one `useIsMutating` sees every
 * write.
 */
const liftingKeyOf = (patientId: string): readonly ['lifting', string] => ['lifting', patientId]

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

export { liftingKeyOf, type LiftingSession, subjectOf, useLiftingWrite, useLiftingWriting }
