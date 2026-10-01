/**
 * The ids the app mints for what it writes. Every resource is written by a
 * `PUT` to an id minted here, never by a server-assigned `POST`, so a retry
 * that mints the same ids overwrites what already landed instead of
 * duplicating it.
 *
 * @packageDocumentation
 */

/** A new id for a resource: a random UUID, 36 characters FHIR allows in an `id`. */
const mintResourceId = (): string => globalThis.crypto.randomUUID()

export { mintResourceId }
