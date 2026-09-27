import { Data, Either, Schema } from 'effect'
import { trimTrailingSlashes } from 'fhir-r4/clients'
import { HumanName } from 'fhir-r4/data-types'

import type * as PatientSummary from './patient-summary.ts'

/**
 * What the watch receives: everything its PebbleKit JS needs to sync the data
 * the Pebble collects to one patient's record as FHIR Observations, plus who
 * that patient is, so the watch can show it for confirmation on-device.
 *
 * @remarks
 * A namespace module — consumers speak `PebbleSettings.Connection`,
 * `PebbleSettings.fromGrant`, `PebbleSettings.withPatient`,
 * `PebbleSettings.toJson`. The settings come together in two steps, because
 * the facts arrive separately: the SMART grant names the token and server (a
 * {@link Connection}), and the patient the user then picks on the settings page
 * supplies the id, name and birth date ({@link withPatient}).
 *
 * The JSON {@link toJson} writes is the wire shape the watchapp's
 * `decodeResponse` (`apps/fhir-sync-pebble/src/pkjs/settings.js`) parses;
 * change the two together. The watchapp's tests round-trip one through the
 * other.
 *
 * @packageDocumentation
 */

const ConnectionSchema = Schema.Struct({
  /** The SMART access token, sent as `Authorization: Bearer …`. */
  accessToken: Schema.NonEmptyString,
  /**
   * The FHIR base URL the token was granted for, without trailing slashes;
   * Observations are POSTed under it.
   */
  fhirBaseUrl: Schema.NonEmptyString,
})

/** What the SMART grant carries: the token and the server it was granted for. */
type Connection = typeof ConnectionSchema.Type

const PebbleSettingsSchema = Schema.Struct({
  /** The logical id of the patient the user picked. */
  patientId: Schema.NonEmptyString,
  /** The patient's display name, `fhir-r4`'s `HumanName.displayName`; `null` when the record has none. */
  patientName: Schema.NullOr(Schema.String),
  /**
   * The patient's birth date as the server wrote it (`YYYY-MM-DD`, or a partial
   * `YYYY-MM` / `YYYY`); `null` when the record has none.
   */
  patientBirthDate: Schema.NullOr(Schema.String),
  accessToken: Schema.NonEmptyString,
  fhirBaseUrl: Schema.NonEmptyString,
})

/** The settings the watch receives. */
type Type = typeof PebbleSettingsSchema.Type

/**
 * The server finished the SMART handshake without granting what the watch
 * needs: no access token.
 */
class MissingGrantError extends Data.TaggedError('MissingGrantError') {}

/** The raw facts a completed SMART handshake reports, before they are checked. */
interface Grant {
  /** The token response's `access_token`, absent for an open server. */
  readonly accessToken: string | undefined
  /** The FHIR base the handshake named. */
  readonly fhirBaseUrl: string
}

const decodeConnection = Schema.decodeUnknownEither(ConnectionSchema)

/**
 * The connection a grant carries, or {@link MissingGrantError} when it carries no token.
 *
 * @remarks
 * The base URL is the one the handshake named, trimmed by `fhir-r4`'s
 * `trimTrailingSlashes` — the rule the page's own reads go through — so the
 * watch, which appends `/Observation` to it, addresses the server as the page
 * did. A server entered as `https://fhir.example/r4/` would otherwise have it
 * POST to `…/r4//Observation`.
 */
const fromGrant = (grant: Grant): Either.Either<Connection, MissingGrantError> =>
  Either.mapLeft(
    decodeConnection({ ...grant, fhirBaseUrl: trimTrailingSlashes(grant.fhirBaseUrl) }),
    () => new MissingGrantError()
  )

/**
 * The settings for `connection`, recording for `patient` and naming them as
 * the server returned them.
 *
 * @param connection - The token and server the grant carried
 * @param patient - The patient the user picked from the server's list
 */
const withPatient = (connection: Connection, patient: PatientSummary.Type): Type => ({
  patientId: patient.id,
  patientName: HumanName.displayName(patient.name),
  patientBirthDate: patient.birthDate,
  accessToken: connection.accessToken,
  fhirBaseUrl: connection.fhirBaseUrl,
})

/** The settings as the JSON the watchapp parses. */
const toJson: (settings: Type) => string = Schema.encodeSync(Schema.parseJson(PebbleSettingsSchema))

export { fromGrant, MissingGrantError, PebbleSettingsSchema as Schema, toJson, withPatient }
export type { Connection, Grant, Type }
