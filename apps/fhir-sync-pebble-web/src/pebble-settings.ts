import { Data, Either, Schema } from 'effect'
import type { PatientResource } from 'fhir-r4-react'
import { HumanName } from 'fhir-r4/data-types'

/**
 * What the watch receives: everything its PebbleKit JS needs to sync the data
 * the Pebble collects to one patient's record as FHIR Observations, plus who
 * that patient is, so the watch can show it for confirmation on-device.
 *
 * @remarks
 * A namespace module — consumers speak `PebbleSettings.Connection`,
 * `PebbleSettings.fromGrant`, `PebbleSettings.withPatient`,
 * `PebbleSettings.toJson`. The settings come together in two steps, because
 * the facts arrive separately: the SMART grant names the patient, token and
 * server (a {@link Connection}), and the patient read that follows supplies the
 * name and birth date ({@link withPatient}).
 *
 * The JSON {@link toJson} writes is the wire shape the watchapp's
 * `webviewclosed` handler parses; change the two together.
 *
 * @packageDocumentation
 */

const ConnectionSchema = Schema.Struct({
  /** The logical id of the patient the server's consent step put in context. */
  patientId: Schema.NonEmptyString,
  /** The SMART access token, sent as `Authorization: Bearer …`. */
  accessToken: Schema.NonEmptyString,
  /** The FHIR base URL the token was granted for; Observations are POSTed under it. */
  fhirBaseUrl: Schema.NonEmptyString,
})

/** What the SMART grant carries: the patient, the token and the server. */
type Connection = typeof ConnectionSchema.Type

const PebbleSettingsSchema = Schema.Struct({
  patientId: Schema.NonEmptyString,
  /** The patient's display name, `given family` (else the name's text); `null` when the record has none. */
  patientName: Schema.NullOr(Schema.String),
  /** The patient's birth date as FHIR writes it (`YYYY-MM-DD`); `null` when the record has none. */
  patientBirthDate: Schema.NullOr(Schema.String),
  accessToken: Schema.NonEmptyString,
  fhirBaseUrl: Schema.NonEmptyString,
})

/** The settings the watch receives. */
type Type = typeof PebbleSettingsSchema.Type

/**
 * The server finished the SMART handshake without granting what the watch
 * needs: no patient in context, or no access token.
 */
class MissingGrantError extends Data.TaggedError('MissingGrantError') {}

/** The raw facts a completed SMART handshake reports, before they are checked. */
interface Grant {
  /** fhirclient's `client.patient.id` — `null` when the server put no patient in context. */
  readonly patientId: string | null
  /** The token response's `access_token`, absent for an open server. */
  readonly accessToken: string | undefined
  /** The FHIR base the handshake named. */
  readonly fhirBaseUrl: string
}

const decodeConnection = Schema.decodeUnknownEither(ConnectionSchema)

/** The connection a grant carries, or {@link MissingGrantError} when it lacks any of it. */
const fromGrant = (grant: Grant): Either.Either<Connection, MissingGrantError> =>
  Either.mapLeft(decodeConnection(grant), () => new MissingGrantError())

/** The settings for `connection`, naming the patient as the server returned it. */
const withPatient = (connection: Connection, patient: PatientResource): Type => ({
  patientId: connection.patientId,
  patientName: HumanName.displayName(patient.name),
  patientBirthDate: patient.birthDate,
  accessToken: connection.accessToken,
  fhirBaseUrl: connection.fhirBaseUrl,
})

/** The settings as the JSON the watchapp parses. */
const toJson: (settings: Type) => string = Schema.encodeSync(Schema.parseJson(PebbleSettingsSchema))

export { fromGrant, MissingGrantError, PebbleSettingsSchema as Schema, toJson, withPatient }
export type { Connection, Grant, Type }
