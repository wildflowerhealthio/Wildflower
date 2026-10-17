import { createFileRoute } from '@tanstack/react-router'
import {
  ConfirmDialog,
  ErrorBanner,
  ItemList,
  type ItemListItem,
} from '@wildflowerhealthio/react-tundraish'
import {
  type CertificateAuthority,
  CertificateState,
  DuplicateCertificates,
  type ListedServer,
} from '@wildflowerhealthio/servers-core-js'
import { Match, Option } from 'effect'
import type { JSX } from 'react'

import { useListedServer } from '../-listed-server.ts'
import { formatInstant, orderingWithoutCertificateNote } from '../../../../server-status-text.ts'
import { useHasPassed } from '../../../../use-has-passed.ts'
import {
  type CertificateAction,
  type CertificateActions,
  useCertificateActions,
} from './-certificate-actions.ts'
import styles from './-certificate.module.css'

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
 * orders from, its record's, which Save App Launcher URL and Save Authorization
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
  ...Option.toArray(
    Option.liftPredicate(certificate.issuer, (issuer) => issuer !== certificateAuthority)
  ).map((issuer): ItemListItem => ({
    id: 'certificate-issuer',
    title: 'State shown for',
    subtitle: CERTIFICATE_AUTHORITY_TEXT[issuer],
  })),
  ...Option.toArray(certificate.held).flatMap((held): readonly ItemListItem[] => [
    { id: 'valid-from', title: 'Valid from', subtitle: formatInstant(held.notBefore) },
    { id: 'valid-until', title: 'Valid until', subtitle: formatInstant(held.notAfter) },
    { id: 'fingerprint', title: 'SHA-256 fingerprint', subtitle: held.fingerprint },
  ]),
  ...Option.toArray(certificate.lastError).map((error): ItemListItem => ({
    id: 'last-error',
    title: 'Last error',
    subtitle: certificateErrorText(error, retryHasPassed),
    tone: 'danger',
  })),
]

/** Each action's button and confirm. */
const CERTIFICATE_ACTION_TEXT: Readonly<
  Record<
    CertificateAction,
    {
      readonly label: string
      readonly title: string
      readonly confirmLabel: string
      readonly question: string
      readonly destructive: boolean
    }
  >
> = {
  getCertificate: {
    label: 'Get certificate',
    title: 'Get a certificate now?',
    confirmLabel: 'Get certificate',
    question: 'The server orders one now, without waiting for its next try.',
    destructive: false,
  },
  orderNewCertificate: {
    label: 'Order a new certificate',
    title: 'Order a new certificate?',
    confirmLabel: 'Order',
    question:
      "The server drops its certificate and orders a new one. It can't be reached until the new certificate arrives, usually within a minute or two.",
    destructive: true,
  },
}

/**
 * What the confirm says of the CA's duplicate-certificate limit once this
 * order would use it up: how many the CA allows and has issued, and when it
 * issues another after this one. None below that.
 */
const nearLimitText = (duplicates: DuplicateCertificates.Type): Option.Option<string> =>
  Option.liftPredicate(duplicates, DuplicateCertificates.nextReachesLimit).pipe(
    Option.map(({ limit, count, oldestLeavesWindowAt }) =>
      [
        `Let's Encrypt issues at most ${limit} certificates for this server's domain in 7 days, and has issued ${count}.`,
        ...Option.toArray(oldestLeavesWindowAt).map(
          (at) => `After this one, it can't issue another until ${formatInstant(at)}.`
        ),
      ].join(' ')
    )
  )

/**
 * The tab's action on a running server, `actions.action` (see
 * `useCertificateActions`): the CA's duplicate-certificate limit while it is
 * reached, and the latest failure, above the button, which opens its
 * confirm. The confirm says what the action does and, once this order would
 * use the CA's limit up, the limit.
 */
const CertificateActionsSection = ({
  actions,
}: {
  readonly actions: CertificateActions
}): JSX.Element | null =>
  actions.action.pipe(
    Option.map((action) => {
      const confirmText =
        CERTIFICATE_ACTION_TEXT[Option.getOrElse(actions.confirming, () => action)]
      return (
        <div key="certificate-actions" className={styles['certificate__actions']}>
          {actions.limitReachedUntil.pipe(
            Option.map((at) => (
              <p key="limit-reached" className={`text-body-3 ${styles['certificate__note']}`}>
                {`Let's Encrypt has issued as many certificates for this server's domain in 7 days as it allows. It can issue another after ${formatInstant(at)}.`}
              </p>
            )),
            Option.getOrNull
          )}
          <ErrorBanner error={Option.getOrNull(actions.failure)} />
          <button
            type="button"
            className={`button-2 outline ${styles['certificate__action']}`}
            disabled={actions.disabled}
            onClick={actions.ask}
          >
            {CERTIFICATE_ACTION_TEXT[action].label}
          </button>
          <ConfirmDialog
            open={Option.isSome(actions.confirming)}
            title={confirmText.title}
            confirmLabel={confirmText.confirmLabel}
            destructive={confirmText.destructive}
            pending={actions.isOrdering}
            onConfirm={actions.confirm}
            onCancel={actions.cancel}
          >
            {[
              confirmText.question,
              ...Option.toArray(actions.duplicates.pipe(Option.flatMap(nearLimitText))),
            ].join(' ')}
          </ConfirmDialog>
        </div>
      )
    }),
    Option.getOrNull
  )

/**
 * The server page's Certificate tab, `/servers/$domain/certificate`: the
 * server's certificate, rendering again when a rate limit's retry time
 * passes; while the server runs ordering one with none to serve, that it
 * can't be reached until one arrives; and its certificate action. It shows
 * each row in full (`maxLines={null}`): the fingerprint is compared by hand
 * and a CA's error detail can run long.
 */
const ServerCertificateTab = (): JSX.Element => {
  const server = useListedServer()
  const retryHasPassed = useHasPassed(CertificateState.retryAfterOf(server.certificate))
  const actions = useCertificateActions(server)
  return (
    <div className={styles['certificate']}>
      <ItemList
        title="Certificate"
        maxLines={null}
        items={certificateItems(server, retryHasPassed)}
      />
      {orderingWithoutCertificateNote(server.status).pipe(
        Option.map((note) => (
          <p key="unreachable" className={`text-body-3 ${styles['certificate__note']}`}>
            {note}
          </p>
        )),
        Option.getOrNull
      )}
      <CertificateActionsSection actions={actions} />
    </div>
  )
}

export const Route = createFileRoute('/servers/$domain/certificate')({
  component: ServerCertificateTab,
})
