import { queryOptions, useMutation, useQuery, type UseQueryOptions } from '@tanstack/react-query'
import {
  type CertificateAuthority,
  DuplicateCertificates,
  getServerCertificate,
  type HostCommandError,
  type ListedServer,
  orderNewServerCertificate,
  readDuplicateCertificates,
} from '@wildflowerhealthio/servers-core-js'
import { type DateTime, Option } from 'effect'
import { useState } from 'react'

import { failureText } from '../../../../failure-text.ts'
import { type RunHostCommand, useRunHostCommand } from '../../../../router-context.ts'

/** Which action the Certificate tab offers a running server. */
type CertificateAction =
  /** It holds no certificate: order one now, even while a failed order backs off. */
  | 'getCertificate'
  /** It holds one: drop it and order a new one. */
  | 'orderNewCertificate'

/** The key of a server's duplicate-certificate count, for the certificate it holds now. */
const duplicateCertificatesQueryKey = (
  domain: string,
  certificateAuthority: CertificateAuthority.Type,
  heldFingerprint: string | null
): readonly ['servers', 'duplicate-certificates', string, string, string | null] =>
  ['servers', 'duplicate-certificates', domain, certificateAuthority, heldFingerprint] as const

/**
 * How many certificates the server `domain`'s CA has issued for its domain
 * in the CA's duplicate-certificate window; none for a CA with no limit a
 * server reaches. Keyed by the certificate the server holds, so a newly
 * deployed one is counted; nothing polls.
 */
const duplicateCertificatesQueryOptions = (
  runHostCommand: RunHostCommand,
  { domain, certificateAuthority, certificate }: ListedServer.Type
): UseQueryOptions<
  Option.Option<DuplicateCertificates.Type>,
  HostCommandError,
  Option.Option<DuplicateCertificates.Type>,
  ReturnType<typeof duplicateCertificatesQueryKey>
> =>
  queryOptions({
    queryKey: duplicateCertificatesQueryKey(
      domain,
      certificateAuthority,
      certificate.held.pipe(
        Option.map((held) => held.fingerprint),
        Option.getOrNull
      )
    ),
    queryFn: () => runHostCommand(readDuplicateCertificates({ domain })),
  })

/** The Certificate tab's action on a running server, and its confirm. */
interface CertificateActions {
  /** The action that applies, while the server runs. */
  readonly action: Option.Option<CertificateAction>
  /**
   * The CA's duplicate-certificate count for the server, once read, for a
   * CA with a limit to reach.
   */
  readonly duplicates: Option.Option<DuplicateCertificates.Type>
  /**
   * When the CA issues the server another certificate, while its
   * duplicate-certificate limit is reached; the action is disabled until then.
   */
  readonly limitReachedUntil: Option.Option<DateTime.Utc>
  /** Whether the action can't be asked now: the count is being read, the limit is reached, or one is in flight. */
  readonly disabled: boolean
  /**
   * The action whose confirm is open: the one that applied when it was
   * asked, so confirming orders what the confirm said even if the server's
   * certificate has changed since.
   */
  readonly confirming: Option.Option<CertificateAction>
  /** Whether the action is in flight. */
  readonly isOrdering: boolean
  /** Why reading the count, or the latest action, failed. */
  readonly failure: Option.Option<string>
  /** Opens the confirm. */
  readonly ask: () => void
  /** Closes the confirm without ordering. */
  readonly cancel: () => void
  /** Asks the host for the confirm's action, closing the confirm once it answers. */
  readonly confirm: () => void
}

/**
 * The Certificate tab's action on `server`: while it runs, "Get certificate"
 * when it holds no certificate and "Order a new certificate" when it holds
 * one, behind a confirm, with its CA's duplicate-certificate count read
 * while it runs.
 */
const useCertificateActions = (server: ListedServer.Type): CertificateActions => {
  const runHostCommand = useRunHostCommand()
  const running = server.status.runState === 'running'
  const action = Option.liftPredicate<CertificateAction>(
    Option.isSome(server.certificate.held) ? 'orderNewCertificate' : 'getCertificate',
    () => running
  )
  const duplicatesQuery = useQuery({
    ...duplicateCertificatesQueryOptions(runHostCommand, server),
    enabled: running,
  })
  const order = useMutation<null, HostCommandError, CertificateAction>({
    mutationFn: (certificateAction) =>
      runHostCommand(
        certificateAction === 'getCertificate'
          ? getServerCertificate({ domain: server.domain })
          : orderNewServerCertificate({ domain: server.domain })
      ),
  })
  const [confirming, setConfirming] = useState<Option.Option<CertificateAction>>(Option.none())
  const duplicates = Option.fromNullable(duplicatesQuery.data).pipe(Option.flatten)
  const limitReachedUntil = duplicates.pipe(
    Option.filter(DuplicateCertificates.isAtLimit),
    Option.flatMap(({ oldestLeavesWindowAt }) => oldestLeavesWindowAt)
  )
  return {
    action,
    duplicates,
    limitReachedUntil,
    disabled: duplicatesQuery.isPending || Option.isSome(limitReachedUntil) || order.isPending,
    confirming,
    isOrdering: order.isPending,
    failure: Option.fromNullable(order.error ?? duplicatesQuery.error).pipe(
      Option.map(failureText)
    ),
    ask: () => {
      setConfirming(action)
    },
    cancel: () => {
      setConfirming(Option.none())
    },
    confirm: () => {
      if (Option.isNone(confirming)) return
      order.mutate(confirming.value, {
        onSettled: () => {
          setConfirming(Option.none())
        },
      })
    },
  }
}

export { useCertificateActions }
export type { CertificateAction, CertificateActions }
