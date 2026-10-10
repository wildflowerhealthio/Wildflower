import {
  queryOptions,
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryOptions,
} from '@tanstack/react-query'
import { Effect, Either } from 'effect'
import { useEffect } from 'react'
import {
  type ApprovalOutcome,
  approveConsent,
  type ConsentApproval,
  type ConsentDetails,
  ConsentKey,
  denyConsent,
  type HostCommandError,
  listPendingConsents,
  PendingConsent,
  readConsent,
} from 'servers-core-js'

import type { ListenToHostEvent, RunHostCommand } from './router-context.ts'

const PENDING_CONSENTS_QUERY_KEY = ['servers', 'pending-consents'] as const

/**
 * The consents waiting on the running servers, one per server with one, in
 * the order they joined the queue; {@link usePendingConsentEvents} keeps it
 * current.
 */
const pendingConsentsQueryOptions = (
  runHostCommand: RunHostCommand
): UseQueryOptions<
  readonly PendingConsent.Waiting[],
  HostCommandError,
  readonly PendingConsent.Waiting[],
  typeof PENDING_CONSENTS_QUERY_KEY
> =>
  queryOptions({
    queryKey: PENDING_CONSENTS_QUERY_KEY,
    queryFn: () => runHostCommand(listPendingConsents).then(PendingConsent.waitingOf),
  })

/**
 * While mounted, put each `pending-consent` event into the cached queue.
 *
 * @remarks
 * Once listening, the queue is read again, so a consent that arrived before
 * the listener was up is not missed. An event that arrives before the first
 * read answers is dropped: that read, made after the host sent it, holds it.
 */
const usePendingConsentEvents = (listenToHostEvent: ListenToHostEvent): void => {
  const queryClient = useQueryClient()
  useEffect(() => {
    const putPendingConsent = (pendingConsent: PendingConsent.Type): void => {
      queryClient.setQueryData<readonly PendingConsent.Waiting[]>(
        PENDING_CONSENTS_QUERY_KEY,
        (waiting) =>
          waiting === undefined
            ? undefined
            : PendingConsent.withPendingConsent(waiting, pendingConsent)
      )
    }
    let unmounted = false
    let stopListening: (() => void) | undefined
    void listenToHostEvent(PendingConsent.EVENT, ({ payload }) => {
      Either.match(PendingConsent.decodeEvent(payload), {
        onLeft: (error) => {
          Effect.runSync(
            Effect.logWarning(`[servers] a ${PendingConsent.EVENT} didn't decode`, error)
          )
        },
        onRight: putPendingConsent,
      })
    }).then((stop) => {
      if (unmounted) {
        stop()
        return
      }
      stopListening = stop
      void queryClient.invalidateQueries({ queryKey: PENDING_CONSENTS_QUERY_KEY })
    })
    return () => {
      unmounted = true
      stopListening?.()
    }
  }, [listenToHostEvent, queryClient])
}

/** The consent `waiting.key` on the server `waiting.domain`, as the sheet shows it. */
const consentQueryOptions = (
  runHostCommand: RunHostCommand,
  { domain, key }: PendingConsent.Waiting
): UseQueryOptions<
  ConsentDetails.Type,
  HostCommandError,
  ConsentDetails.Type,
  readonly ['servers', 'consent', string, string]
> =>
  queryOptions({
    queryKey: ['servers', 'consent', domain, ConsentKey.asString(key)] as const,
    queryFn: () => runHostCommand(readConsent({ domain, consent: key })),
    // A waiting consent doesn't change; once decided it is gone.
    staleTime: Number.POSITIVE_INFINITY,
  })

/** The Owner's answer to a consent: an approval, or a denial of its key. */
type ConsentDecision =
  | { readonly kind: 'approve'; readonly approval: ConsentApproval.Type }
  | { readonly kind: 'deny'; readonly consent: ConsentKey.Type }

/**
 * Approves or denies a consent waiting on the server `domain`, answering with
 * what an approval came to; a denial answers `denied`.
 *
 * @remarks
 * `onDecided` hears each outcome even once the caller has unmounted, as it
 * does when the host's `pending-consent` event takes the consent off the
 * queue before the approval answers: React Query skips a callback passed to
 * `mutate` after its component unmounts, but not one passed here.
 */
const useDecideConsent = (
  runHostCommand: RunHostCommand,
  domain: string,
  onDecided: (outcome: ApprovalOutcome.Type, decision: ConsentDecision) => void
): UseMutationResult<ApprovalOutcome.Type, HostCommandError, ConsentDecision> =>
  useMutation({
    onSuccess: onDecided,
    mutationFn: (decision) =>
      decision.kind === 'approve'
        ? runHostCommand(approveConsent({ domain, approval: decision.approval }))
        : runHostCommand(denyConsent({ domain, consent: decision.consent })).then(
            (): ApprovalOutcome.Type => ({ status: 'denied' })
          ),
  })

export {
  consentQueryOptions,
  pendingConsentsQueryOptions,
  useDecideConsent,
  usePendingConsentEvents,
}
export type { ConsentDecision }
