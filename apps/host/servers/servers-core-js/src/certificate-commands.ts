import type { Effect, Option } from 'effect'
import { Schema } from 'effect'

import * as DuplicateCertificates from './duplicate-certificates.ts'
import { type HostCommandError, invokeHostCommand, type TauriInvoke } from './host-commands.ts'

/**
 * How many certificates the server `domain`'s CA has issued for its domain
 * in the CA's duplicate-certificate window, as its certificate history
 * records them; none for a CA with no limit a server reaches, as Let's
 * Encrypt's staging CA.
 *
 * @remarks
 * Fails with the host's refusal, a `CertificateActionError`:
 * `historyUnreadable`, or the registry's `notRegistered` or `registry`.
 */
const readDuplicateCertificates = ({
  domain,
}: {
  readonly domain: string
}): Effect.Effect<Option.Option<DuplicateCertificates.Type>, HostCommandError, TauriInvoke> =>
  invokeHostCommand(
    'server_duplicate_certificates',
    Schema.OptionFromNullOr(DuplicateCertificates.Schema),
    { domain }
  )

/**
 * Have the running server `domain` order a certificate now, even while a
 * failed order backs off. Answers once the new ordering has started.
 *
 * @remarks
 * Fails with the host's refusal, a `CertificateActionError`:
 * `serverNotRunning`, `duplicateLimitReached` once the CA's
 * duplicate-certificate limit is reached, `historyUnreadable`, or the
 * registry's `notRegistered` or `registry`.
 */
const getServerCertificate = ({
  domain,
}: {
  readonly domain: string
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_get_certificate', Schema.Null, { domain })

/**
 * Have the running server `domain` drop its certificate and order a new one
 * now. Until the new one arrives, the server has none to serve, so it can't
 * be reached. Answers once the new ordering has started.
 *
 * @remarks
 * Fails with the host's refusal, as {@link getServerCertificate} does, or
 * `cachedCertificateNotRemoved`, after which the server orders again with the
 * certificate it held.
 */
const orderNewServerCertificate = ({
  domain,
}: {
  readonly domain: string
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_order_new_certificate', Schema.Null, { domain })

export { getServerCertificate, orderNewServerCertificate, readDuplicateCertificates }
