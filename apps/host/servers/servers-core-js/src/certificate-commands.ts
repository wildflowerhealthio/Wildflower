import type { Effect, Option } from 'effect'
import { Schema } from 'effect'

import * as DuplicateCertificateLimit from './duplicate-certificate-limit.ts'
import { type HostCommandError, invokeHostCommand, type TauriInvoke } from './host-commands.ts'

/**
 * How much of its CA's duplicate-certificate limit the server `domain` has
 * used, as this device's certificate history records it; none for a CA with
 * no limit a server reaches, as Let's Encrypt's staging CA.
 *
 * @remarks
 * Fails with the host's refusal (see `CertificateOrderRequestError`):
 * `historyUnreadable`, or the registry's `notRegistered` or `registry`.
 */
const readDuplicateCertificateLimit = ({
  domain,
}: {
  readonly domain: string
}): Effect.Effect<Option.Option<DuplicateCertificateLimit.Type>, HostCommandError, TauriInvoke> =>
  invokeHostCommand(
    'server_duplicate_certificate_limit',
    Schema.OptionFromNullOr(DuplicateCertificateLimit.Schema),
    { domain }
  )

/**
 * Have the running server `domain` order a certificate if it needs one, even
 * while a failed order backs off; a valid certificate it holds is kept.
 * Answers once the new ordering has started.
 *
 * @remarks
 * Fails with the host's refusal (see `CertificateOrderRequestError`):
 * `serverNotRunning`, `limitUsedUp` once the CA's duplicate-certificate limit
 * looks used up, `historyUnreadable`, or the registry's `notRegistered` or
 * `registry`.
 */
const orderServerCertificate = ({
  domain,
}: {
  readonly domain: string
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_order_certificate', Schema.Null, { domain })

/**
 * Have the running server `domain` drop its certificate and order a new one
 * now, regardless. Until the new one arrives, the server has none to serve,
 * so it can't be reached. Answers once the new ordering has started.
 *
 * @remarks
 * Fails with the host's refusal, as {@link orderServerCertificate} does, or
 * `cachedCertificateNotRemoved`, after which the server orders again with the
 * certificate it held.
 */
const forceNewServerCertificate = ({
  domain,
}: {
  readonly domain: string
}): Effect.Effect<null, HostCommandError, TauriInvoke> =>
  invokeHostCommand('server_force_new_certificate', Schema.Null, { domain })

export { forceNewServerCertificate, orderServerCertificate, readDuplicateCertificateLimit }
