import { trimTrailingSlashes } from '@wildflowerhealthio/fhir-r4/clients'
import { identity, Schema } from 'effect'

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
}) {}

export { decodeFhirBaseUrl, FhirBaseUrl, SmartConnection }
