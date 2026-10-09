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

/**
 * Whether browsers trust the CA's certificates: an app's browser accepts a
 * server's certificate only from a CA they trust. Only Let's Encrypt's
 * production CA is. The golden file's `browserTrustedCertificateAuthorities`
 * holds this to the host's `CertificateAuthority::is_browser_trusted`.
 */
const isBrowserTrusted = (authority: Type): boolean => authority === 'letsEncrypt'

export { CertificateAuthoritySchema as Schema, isBrowserTrusted }
export type { Type }
