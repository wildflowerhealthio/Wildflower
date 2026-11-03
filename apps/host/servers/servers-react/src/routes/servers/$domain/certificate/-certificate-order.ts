import { queryOptions, useMutation, useQuery, type UseQueryOptions } from '@tanstack/react-query'
import {
  type CertificateAuthority,
  DuplicateCertificateLimit,
  forceNewServerCertificate,
  type HostCommandError,
  type ListedServer,
  orderServerCertificate,
  readDuplicateCertificateLimit,
} from '@wildflowerhealthio/servers-core-js'
import { type DateTime, Option } from 'effect'
import { useState } from 'react'

import { failureText } from '../../../../failure-text.ts'
import { type RunHostCommand, useRunHostCommand } from '../../../../router-context.ts'

/** Which order the Certificate tab offers a running server. */
type CertificateOrderKind =
  /** It holds no certificate: order one if needed now, even while a failed order backs off. */
  | 'ifNeeded'
  /** It holds one: drop it and order a new one regardless. */
  | 'forced'

/** The key of a server's duplicate-certificate limit, for the certificate it holds now. */
const duplicateCertificateLimitQueryKey = (
  domain: string,
  certificateAuthority: CertificateAuthority.Type,
  heldFingerprint: string | null
): readonly ['servers', 'duplicate-certificate-limit', string, string, string | null] =>
  ['servers', 'duplicate-certificate-limit', domain, certificateAuthority, heldFingerprint] as const

/**
 * How much of its CA's duplicate-certificate limit the server `domain` has
 * used, by this device's certificate history; none for a CA with no limit a
 * server reaches. Keyed by the certificate the server holds, so a newly
 * deployed one is counted; nothing polls.
 */
const duplicateCertificateLimitQueryOptions = (
  runHostCommand: RunHostCommand,
  { domain, certificateAuthority, certificate }: ListedServer.Type
): UseQueryOptions<
  Option.Option<DuplicateCertificateLimit.Type>,
  HostCommandError,
  Option.Option<DuplicateCertificateLimit.Type>,
  ReturnType<typeof duplicateCertificateLimitQueryKey>
> =>
  queryOptions({
    queryKey: duplicateCertificateLimitQueryKey(
      domain,
      certificateAuthority,
      certificate.held.pipe(
        Option.map((held) => held.fingerprint),
        Option.getOrNull
      )
    ),
    queryFn: () => runHostCommand(readDuplicateCertificateLimit({ domain })),
  })

/** The Certificate tab's order for a running server, and its confirm. */
interface CertificateOrder {
  /** The kind of order that applies, while the server runs. */
  readonly kind: Option.Option<CertificateOrderKind>
  /**
   * The CA's duplicate-certificate limit for the server, once read, for a
   * CA with a limit to reach.
   */
  readonly limit: Option.Option<DuplicateCertificateLimit.Type>
  /**
   * When the CA issues the server another certificate, while its
   * duplicate-certificate limit is used up; the order is disabled until then.
   */
  readonly limitUsedUpUntil: Option.Option<DateTime.Utc>
  /** Whether the order can't be asked now: the limit is being read, it is used up, or an order is in flight. */
  readonly disabled: boolean
  /**
   * The kind of order whose confirm is open: the one that applied when it
   * was asked, so confirming orders what the confirm said even if the
   * server's certificate has changed since.
   */
  readonly confirming: Option.Option<CertificateOrderKind>
  /** Whether the order is in flight. */
  readonly isOrdering: boolean
  /** Why reading the limit, or the latest order, failed. */
  readonly failure: Option.Option<string>
  /** Opens the confirm. */
  readonly ask: () => void
  /** Closes the confirm without ordering. */
  readonly cancel: () => void
  /** Asks the host for the confirm's order, closing the confirm once it answers. */
  readonly confirm: () => void
}

/**
 * The Certificate tab's order for `server`: while it runs, "Order
 * certificate" (if needed) when it holds no certificate and "Replace
 * certificate" (forced) when it holds one, behind a confirm, with its CA's
 * duplicate-certificate limit read while it runs.
 */
const useCertificateOrder = (server: ListedServer.Type): CertificateOrder => {
  const runHostCommand = useRunHostCommand()
  const running = server.status.runState === 'running'
  const kind = Option.liftPredicate<CertificateOrderKind>(
    Option.isSome(server.certificate.held) ? 'forced' : 'ifNeeded',
    () => running
  )
  const limitQuery = useQuery({
    ...duplicateCertificateLimitQueryOptions(runHostCommand, server),
    enabled: running,
  })
  const order = useMutation<null, HostCommandError, CertificateOrderKind>({
    mutationFn: (orderKind) =>
      runHostCommand(
        orderKind === 'ifNeeded'
          ? orderServerCertificate({ domain: server.domain })
          : forceNewServerCertificate({ domain: server.domain })
      ),
  })
  const [confirming, setConfirming] = useState<Option.Option<CertificateOrderKind>>(Option.none())
  const limit = Option.fromNullable(limitQuery.data).pipe(Option.flatten)
  const limitUsedUpUntil = limit.pipe(
    Option.filter(DuplicateCertificateLimit.isUsedUp),
    Option.flatMap(({ oldestLeavesWindowAt }) => oldestLeavesWindowAt)
  )
  return {
    kind,
    limit,
    limitUsedUpUntil,
    disabled: limitQuery.isPending || Option.isSome(limitUsedUpUntil) || order.isPending,
    confirming,
    isOrdering: order.isPending,
    failure: Option.fromNullable(order.error ?? limitQuery.error).pipe(Option.map(failureText)),
    ask: () => {
      setConfirming(kind)
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

export { useCertificateOrder }
export type { CertificateOrder, CertificateOrderKind }
