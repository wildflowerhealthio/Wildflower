import { Option, Schema } from 'effect'

import { HostCommandFailed, type HostCommandError } from './host-commands.ts'

/**
 * The refusals the certificate commands answer with, besides the registry's:
 * the server's run isn't up (`serverNotRunning`), a forced order couldn't
 * remove the cached certificate and the run started again from it
 * (`cachedCertificateNotRemoved`), the CA's duplicate-certificate limit looks
 * used up by the server's certificate history (`limitUsedUp`), or that
 * history couldn't be read (`historyUnreadable`).
 */
const KindSchema = Schema.Literal(
  'serverNotRunning',
  'cachedCertificateNotRemoved',
  'limitUsedUp',
  'historyUnreadable'
)

/** A decoded {@link KindSchema}. */
type Kind = typeof KindSchema.Type

const decodeKind = Schema.decodeUnknownOption(KindSchema)

/**
 * Which certificate-order refusal `error` is, when the host ran a certificate
 * command and refused it with one of {@link KindSchema}'s kinds; none for any
 * other failure.
 */
const refusalOf = (error: HostCommandError): Option.Option<Kind> =>
  error instanceof HostCommandFailed
    ? error.refusal.pipe(Option.flatMap((refusal) => decodeKind(refusal.kind)))
    : Option.none()

export { KindSchema, refusalOf }
export type { Kind }
