import { trimTrailingSlashes } from '@wildflowerhealthio/fhir-r4/clients'
import { Scope } from '@wildflowerhealthio/scopes-core'
import { Array, identity, Schema, String } from 'effect'

/**
 * A FHIR server base, e.g. `https://launch.smarthealthit.org/v/r4/fhir`: an
 * EHR launch's `iss`, or the server a reader picked.
 *
 * @remarks
 * Decoding trims its trailing slashes, once, so every request built on it
 * (`${fhirBaseUrl}/Patient`) and every comparison against it reads the same
 * base however it was written.
 */
const FhirBaseUrl = Schema.transform(
  Schema.String,
  Schema.String.pipe(Schema.brand('FhirBaseUrl')),
  { strict: true, decode: trimTrailingSlashes, encode: identity }
)
type FhirBaseUrl = Schema.Schema.Type<typeof FhirBaseUrl>

/** `fhirBaseUrl` as a {@link FhirBaseUrl}, its trailing slashes trimmed. */
const decodeFhirBaseUrl: (fhirBaseUrl: string) => FhirBaseUrl = Schema.decodeSync(FhirBaseUrl)

/**
 * The space-delimited `scope` a sign-in was granted (RFC 6749 §3.3), each
 * token read as its richest {@link Scope.Any}. Reading is total: a token
 * `scopes-core` does not recognise is kept as an `unknown` scope.
 */
const grantedScopesOf = (scope: string): readonly Scope.Any[] =>
  Array.filter(scope.split(' '), String.isNonEmpty).map(Scope.parse)

/**
 * The FHIR server a completed SMART sign-in connected the app to: what every
 * read the app makes is addressed to and carries.
 *
 * @remarks
 * The token lives in this value only, in page memory, and dies with the tab.
 */
class SmartConnection extends Schema.Class<SmartConnection>('SmartConnection')({
  /** The FHIR base every request is addressed to. */
  fhirBaseUrl: FhirBaseUrl,
  /** The bearer token the sign-in redeemed, or `None` for an open server. */
  accessToken: Schema.OptionFromSelf(Schema.String),
  /** The patient the launch put in context, when the token response named one. */
  launchPatientId: Schema.OptionFromSelf(Schema.String),
  /**
   * The scopes the sign-in was granted ({@link grantedScopesOf}): the
   * token response's `scope`, which may be narrower than what the app asked
   * for, or what it asked for when the server named none or is open.
   */
  grantedScopes: Schema.Array(Scope.Schema),
}) {}

export { decodeFhirBaseUrl, FhirBaseUrl, grantedScopesOf, SmartConnection }
