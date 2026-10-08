import { Schema } from 'effect'

/**
 * Which ACME CA a server's certificates are ordered from, as `servers.json`
 * stores it and `servers_list` answers with it: `letsEncryptStaging`, Let's
 * Encrypt's staging CA, whose certificates aren't publicly trusted, or
 * `letsEncrypt`, its production CA.
 */
const CertificateAuthoritySchema = Schema.Literal('letsEncryptStaging', 'letsEncrypt')

/** A decoded {@link CertificateAuthoritySchema}. */
type Type = typeof CertificateAuthoritySchema.Type

export { CertificateAuthoritySchema as Schema }
export type { Type }
