import { Schema } from 'effect'

/**
 * How an app's request compares with its registration on the server:
 * `registered`; `new`, an app the server has never seen; or `changed`, a
 * known app whose redirect (`redirectUriIsNew`) or scopes (`newScopes`) step
 * outside it. Approving a `new` or `changed` request needs the Owner's
 * acknowledgement.
 */
const RegistrationSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('registered') }),
  Schema.Struct({ status: Schema.Literal('new') }),
  Schema.Struct({
    status: Schema.Literal('changed'),
    redirectUriIsNew: Schema.Boolean,
    newScopes: Schema.Array(Schema.String),
  })
)

/** A decoded {@link RegistrationSchema}. */
type Registration = typeof RegistrationSchema.Type

/**
 * A waiting consent as `server_consent_get` answers it. A device pairing may
 * be granted any of `registeredScopes`, the scopes its client is registered for;
 * an app's `/authorize` is granted at most its `requestedScopes`, and gets
 * its answer at `redirectUri`. `patient` is the patient a standing grant
 * already names for the app.
 */
const ConsentDetailsSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('device'),
    userCode: Schema.String,
    clientId: Schema.String,
    clientName: Schema.String,
    deviceName: Schema.optionalWith(Schema.String, { as: 'Option', exact: true }),
    requestedScopes: Schema.Array(Schema.String),
    registeredScopes: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('oauth'),
    id: Schema.String,
    clientId: Schema.String,
    clientName: Schema.String,
    requestedScopes: Schema.Array(Schema.String),
    redirectUri: Schema.URL,
    patient: Schema.optionalWith(Schema.String, { as: 'Option', exact: true }),
    registration: RegistrationSchema,
  })
)

/** A decoded {@link ConsentDetailsSchema}. */
type Type = typeof ConsentDetailsSchema.Type

/** A device's pairing. */
type Device = Extract<Type, { readonly kind: 'device' }>

/** An app's `/authorize`. */
type OAuth = Extract<Type, { readonly kind: 'oauth' }>

/** The app's name as the Owner knows it: its registered name, or its id when that is all it has. */
const appNameOf = (details: Type): string =>
  details.clientName === '' ? details.clientId : details.clientName

export { appNameOf, ConsentDetailsSchema as Schema, RegistrationSchema }
export type { Device, OAuth, Registration, Type }
