import { Option, Schema } from 'effect'

import * as CertificateAuthority from './certificate-authority.ts'
import type * as CertificateState from './certificate-state.ts'
import type * as ServerStatus from './server-status.ts'

/**
 * The refusals `server_launch` answers from the server's status alone, before
 * it mints anything: the server's run isn't up (`serverNotRunning`), its
 * `/health` hasn't been asked through its relay yet (`notYetProbed`) or didn't
 * answer (`unreachable`), it holds no valid certificate
 * (`noValidCertificate`), or its valid certificate is from a CA browsers don't
 * trust, such as Let's Encrypt's staging CA (`untrustedCertificate`).
 * {@link statusRefusalOf} decides the same from a status.
 */
const StatusRefusalKindSchema = Schema.Literal(
  'serverNotRunning',
  'notYetProbed',
  'unreachable',
  'noValidCertificate',
  'untrustedCertificate'
)

/** A decoded {@link StatusRefusalKindSchema}. */
type StatusRefusalKind = typeof StatusRefusalKindSchema.Type

/** The certificate statuses an app's browser accepts: a valid certificate. */
const VALID_CERTIFICATE_STATUSES: readonly CertificateState.Status[] = [
  'noRenewalNeeded',
  'renewalDue',
]

/**
 * Why a running, reachable server whose certificate's state is `certificate`
 * can't be launched, as `server_launch` refuses it; none when the certificate
 * is valid and from a CA browsers trust.
 */
const certificateRefusalOf = (
  certificate: CertificateState.Type
): Option.Option<Extract<StatusRefusalKind, 'noValidCertificate' | 'untrustedCertificate'>> => {
  if (!VALID_CERTIFICATE_STATUSES.includes(certificate.status)) {
    return Option.some('noValidCertificate')
  }
  return CertificateAuthority.isBrowserTrusted(certificate.issuer)
    ? Option.none()
    : Option.some('untrustedCertificate')
}

/**
 * Why the server whose status is `status` can't be launched now, as
 * `server_launch` refuses it; none once it can: its run is up, its `/health`
 * answered through its relay, and its certificate is valid and from a CA
 * browsers trust ({@link certificateRefusalOf}).
 *
 * @remarks
 * The host decides from the same status, its certificate included: the
 * run's, once the run has reported one, or else what the cache says. The
 * golden file's `launchRefusals` and `launchRefusalsByCertificateStatus` hold
 * both sides to the same answers.
 */
const statusRefusalOf = (status: ServerStatus.Type): Option.Option<StatusRefusalKind> => {
  if (status.runState !== 'running') return Option.some('serverNotRunning')
  if (Option.isNone(status.health)) return Option.some('notYetProbed')
  if (status.health.value.kind === 'unreachable') return Option.some('unreachable')
  return certificateRefusalOf(status.certificate)
}

export { certificateRefusalOf, StatusRefusalKindSchema, statusRefusalOf }
export type { StatusRefusalKind }
