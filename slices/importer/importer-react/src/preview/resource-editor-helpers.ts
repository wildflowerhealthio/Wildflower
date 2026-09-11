import { Either, Schema } from 'effect'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'

/**
 * Pure helpers for the inline resource editor: the pretty-printer that
 * seeds its textarea, the classifier that decides whether an edit can be
 * kept, and the two `Error` subclasses it may raise. Lifted out of the
 * dialog component so React fast-refresh stays happy (it re-loads a file
 * that only exports components) and the classifier is exercised in the
 * test without spinning up the dialog.
 *
 * @packageDocumentation
 */

/** How many spaces each nesting level is indented by in the editable JSON. */
const JSON_INDENT = 2

/** The text a mount seeds its textarea with: `resource` pretty-printed as JSON. */
const prettyPrintResource = (resource: unknown): string =>
  JSON.stringify(resource, null, JSON_INDENT)

/** Raised by {@link tryKeep} when the edit text is not valid JSON. */
class InvalidJsonError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'InvalidJsonError'
  }
}

/** Raised by {@link tryKeep} when the reviewer tried to change `id` or `resourceType`. */
class ImmutableFieldChangedError extends Error {
  readonly field: 'resourceType' | 'id'
  constructor(field: 'resourceType' | 'id', from: string | null, to: string | null) {
    super(
      `${field} is read-only: cannot change from ${from ?? '(none)'} to ${to ?? '(none)'}` +
        ` — it would break every reference and the provenance link.`
    )
    this.name = 'ImmutableFieldChangedError'
    this.field = field
  }
}

/** Read `field` off a resource as a string, or `null` when it is not one. */
const stringFieldOf = (resource: unknown, field: 'resourceType' | 'id'): string | null => {
  if (typeof resource !== 'object' || resource === null || !(field in resource)) return null
  const value: unknown = Reflect.get(resource, field)
  return typeof value === 'string' ? value : null
}

/**
 * Try to keep one edit: parse the text, decode as
 * {@link FhirResourceSchema}, and refuse a change to the two read-only
 * fields.
 *
 * @returns `Right` the decoded resource, or `Left` the error the banner
 *   should render — a `ParseError` for a schema failure, an
 *   {@link InvalidJsonError} for malformed JSON, or an
 *   {@link ImmutableFieldChangedError} for an attempt to change `id` or
 *   `resourceType`.
 */
const tryKeep = (text: string, original: unknown): Either.Either<FhirResource, unknown> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return Either.left(new InvalidJsonError(error))
  }
  const decoded = Schema.decodeUnknownEither(FhirResourceSchema)(parsed)
  if (Either.isLeft(decoded)) return decoded
  const originalType = stringFieldOf(original, 'resourceType')
  const nextType = stringFieldOf(decoded.right, 'resourceType')
  if (originalType !== null && nextType !== originalType) {
    return Either.left(new ImmutableFieldChangedError('resourceType', originalType, nextType))
  }
  const originalId = stringFieldOf(original, 'id')
  const nextId = stringFieldOf(decoded.right, 'id')
  if (originalId !== null && nextId !== originalId) {
    return Either.left(new ImmutableFieldChangedError('id', originalId, nextId))
  }
  return Either.right(decoded.right)
}

export { ImmutableFieldChangedError, InvalidJsonError, prettyPrintResource, tryKeep }
