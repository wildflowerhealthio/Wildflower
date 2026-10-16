import { createFileRoute } from '@tanstack/react-router'
import { ItemList, type ItemListItem } from '@wildflowerhealthio/react-tundraish'
import {
  type CertificateAuthority,
  CertificateState,
  type ListedServer,
} from '@wildflowerhealthio/servers-core-js'
import { Match, Option } from 'effect'
import type { JSX } from 'react'

import { formatInstant } from '../../../../server-status-text.ts'
import { useHasPassed } from '../../../../use-has-passed.ts'
import { useListedServer } from './-listed-server.ts'

/** What the Certificate authority row says of each CA. */
const CERTIFICATE_AUTHORITY_TEXT: Readonly<Record<CertificateAuthority.Type, string>> = {
  letsEncrypt: "Let's Encrypt",
  letsEncryptStaging: "Let's Encrypt staging, which browsers don't trust",
}

/** What the certificate's Status row says of each status. */
const CERTIFICATE_STATUS_TEXT: Readonly<Record<CertificateState.Status, string>> = {
  notIssued: 'None yet. The server orders one when it runs.',
  ordering: 'Ordering one from the certificate authority.',
  noRenewalNeeded: 'Valid.',
  renewalDue: 'Valid, and due for renewal, which the server makes while it runs.',
  expired: 'Expired. The server renews it when it starts.',
  orderFailing: 'No valid certificate: ordering one is failing.',
  cacheUnreadable: "The certificate stored on this device couldn't be read.",
}

/**
 * The tone of the certificate's Status row for each status: only a failing
 * order or an unreadable cache is a failure. A stopped server's certificate
 * lapses and renews when it starts, so `expired` is not one.
 */
const CERTIFICATE_STATUS_TONE: Readonly<
  Record<CertificateState.Status, NonNullable<ItemListItem['tone']>>
> = {
  notIssued: 'neutral',
  ordering: 'neutral',
  noRenewalNeeded: 'neutral',
  renewalDue: 'neutral',
  expired: 'neutral',
  orderFailing: 'danger',
  cacheUnreadable: 'danger',
}

/**
 * What the Last error row says of a run's latest certificate error;
 * `retryHasPassed` is whether a rate limit's retry time has passed.
 */
const certificateErrorText = (
  error: CertificateState.OrderError,
  retryHasPassed: boolean
): string =>
  Match.value(error).pipe(
    Match.when({ kind: 'rateLimited' }, ({ retryAfter }) =>
      retryAfter.pipe(
        Option.map(
          (at) =>
            `The certificate authority's rate limit was reached; it said to retry after ${formatInstant(at)}${retryHasPassed ? '; that time has passed.' : '.'}`
        ),
        Option.getOrElse(() => "The certificate authority's rate limit was reached.")
      )
    ),
    Match.when({ kind: 'challengeFailed' }, ({ detail }) =>
      detail.pipe(
        Option.map(
          (text) => `The certificate authority couldn't validate this server's domain: ${text}`
        ),
        Option.getOrElse(() => "The certificate authority couldn't validate this server's domain.")
      )
    ),
    Match.when(
      { kind: 'caUnreachable' },
      ({ message }) => `The certificate authority couldn't be reached: ${message}`
    ),
    Match.when({ kind: 'other' }, ({ message }) => `Ordering failed: ${message}`),
    Match.when(
      { kind: 'cache' },
      ({ message }) => `The certificates on this device couldn't be read or written: ${message}`
    ),
    Match.exhaustive
  )

/**
 * The server's certificate for its domain: its status; the CA the server
 * orders from, its record's, which Save Launcher URL and Save Authorization
 * Manager URL save unchanged, and, when the certificate state is for another
 * CA (`issuer`), as before a changed CA takes effect, the CA the state is for; the certificate
 * held, with when it is valid and its fingerprint; and the run's latest error
 * since it last deployed one, `retryHasPassed` saying whether a rate limit's
 * retry time has passed.
 */
const certificateItems = (
  { certificateAuthority, certificate }: ListedServer.Type,
  retryHasPassed: boolean
): readonly ItemListItem[] => [
  {
    id: 'certificate-status',
    title: 'Status',
    subtitle: CERTIFICATE_STATUS_TEXT[certificate.status],
    tone: CERTIFICATE_STATUS_TONE[certificate.status],
  },
  {
    id: 'certificate-authority',
    title: 'Certificate authority',
    subtitle: CERTIFICATE_AUTHORITY_TEXT[certificateAuthority],
  },
  ...(certificate.issuer === certificateAuthority
    ? []
    : [
        {
          id: 'certificate-issuer',
          title: 'State shown for',
          subtitle: CERTIFICATE_AUTHORITY_TEXT[certificate.issuer],
        },
      ]),
  ...certificate.held.pipe(
    Option.map((held): readonly ItemListItem[] => [
      { id: 'valid-from', title: 'Valid from', subtitle: formatInstant(held.notBefore) },
      { id: 'valid-until', title: 'Valid until', subtitle: formatInstant(held.notAfter) },
      { id: 'fingerprint', title: 'SHA-256 fingerprint', subtitle: held.fingerprint },
    ]),
    Option.getOrElse((): readonly ItemListItem[] => [])
  ),
  ...certificate.lastError.pipe(
    Option.map((error): ItemListItem => ({
      id: 'last-error',
      title: 'Last error',
      subtitle: certificateErrorText(error, retryHasPassed),
      tone: 'danger',
    })),
    Option.toArray
  ),
]

/**
 * The server page's Certificate tab, `/servers/$domain/certificate`: the
 * server's certificate, rendering again when a rate limit's retry time
 * passes. It shows each row in full (`maxLines={null}`): the fingerprint is
 * compared by hand and a CA's error detail can run long.
 */
const ServerCertificateTab = (): JSX.Element => {
  const server = useListedServer()
  const retryHasPassed = useHasPassed(CertificateState.retryAfterOf(server.certificate))
  return (
    <ItemList
      title="Certificate"
      maxLines={null}
      items={certificateItems(server, retryHasPassed)}
    />
  )
}

export const Route = createFileRoute('/_servers/servers/$domain/certificate')({
  component: ServerCertificateTab,
})
