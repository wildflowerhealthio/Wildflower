import { Either, Schema } from 'effect'
import { type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'

/**
 * Pure helpers for the inline resource editor: the truncating
 * pretty-printer that seeds its textarea (with tracked substitutions so
 * the originals can be restored on keep), the classifier that decides
 * whether an edit can be kept, and the `Error` subclasses it may raise.
 * Lifted out of the dialog component so React fast-refresh stays happy
 * (it re-loads a file that only exports components) and the classifier
 * is exercised in the test without spinning up the dialog.
 *
 * @packageDocumentation
 */

/** How many spaces each nesting level is indented by in the editable JSON. */
const JSON_INDENT = 2

/**
 * String values at or above this byte length are replaced with a
 * `[N bytes]` placeholder in the editor's display text. The actual
 * resource data stays intact — truncation is purely presentational,
 * and the substitutions are tracked so they can be restored on keep.
 */
const TRUNCATION_THRESHOLD = 10_000

/** One substitution the truncating pretty-printer made. */
interface Substitution {
  /** The path segments from the root to the truncated value. */
  readonly path: readonly (string | number)[]
  /** The placeholder string that replaced the original, e.g. `"[10,000 bytes]"`. */
  readonly placeholder: string
  /** The original string value before truncation. */
  readonly original: string
}

/** The result of {@link prettyPrintResource}: display text plus tracked substitutions. */
interface TruncatedPrint {
  readonly text: string
  readonly substitutions: readonly Substitution[]
}

/**
 * Walk `value` recursively, replacing long strings with placeholders
 * and recording each substitution. Returns a display-safe copy —
 * the original is never mutated.
 */
const truncateForDisplay = (
  value: unknown,
  threshold: number,
  path: (string | number)[],
  substitutions: Substitution[]
): unknown => {
  if (typeof value === 'string' && value.length >= threshold) {
    const placeholder = `[${value.length.toLocaleString('en-US')} bytes]`
    substitutions.push({ path: [...path], placeholder, original: value })
    return placeholder
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      path.push(i)
      const result = truncateForDisplay(item, threshold, path, substitutions)
      path.pop()
      return result
    })
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      path.push(key)
      out[key] = truncateForDisplay(Reflect.get(value, key), threshold, path, substitutions)
      path.pop()
    }
    return out
  }
  return value
}

const prettyPrintResource = (resource: unknown): TruncatedPrint => {
  const substitutions: Substitution[] = []
  const display = truncateForDisplay(resource, TRUNCATION_THRESHOLD, [], substitutions)
  return { text: JSON.stringify(display, null, JSON_INDENT), substitutions }
}

// ---------------------------------------------------------------------------
// Substitution restoration
// ---------------------------------------------------------------------------

const getAtPath = (obj: unknown, path: readonly (string | number)[]): unknown => {
  let current: unknown = obj
  for (const segment of path) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = Reflect.get(current, segment)
  }
  return current
}

const setAtPath = (obj: unknown, path: readonly (string | number)[], value: unknown): void => {
  let current: unknown = obj
  for (let i = 0; i < path.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== 'object') return
    current = Reflect.get(current, path[i])
  }
  if (current !== null && current !== undefined && typeof current === 'object') {
    Reflect.set(current, path[path.length - 1], value)
  }
}

/** The outcome of restoring substitutions into a parsed-back object. */
interface RestoreResult {
  readonly restored: unknown
  readonly editedPlaceholders: readonly Substitution[]
}

/**
 * Given a parsed JSON value (from the user's edited text) and the
 * substitutions the pretty-printer recorded, restore every placeholder
 * the user left intact to its original value. Any placeholder the user
 * changed is collected in `editedPlaceholders` — those fields will
 * contain whatever the user typed, not the original data.
 */
const restoreSubstitutions = (
  parsed: unknown,
  substitutions: readonly Substitution[]
): RestoreResult => {
  if (substitutions.length === 0) return { restored: parsed, editedPlaceholders: [] }
  const editedPlaceholders: Substitution[] = []
  const restored = structuredClone(parsed)
  for (const sub of substitutions) {
    const current = getAtPath(restored, sub.path)
    if (current === sub.placeholder) {
      setAtPath(restored, sub.path, sub.original)
    } else if (current !== sub.original) {
      editedPlaceholders.push(sub)
    }
  }
  return { restored, editedPlaceholders }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

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

/**
 * Raised by {@link tryKeep} when the user edited one or more
 * placeholders that stood in for large truncated values. The original
 * data at those paths will be replaced by whatever the user typed.
 */
class PlaceholderEditedWarning extends Error {
  readonly editedPlaceholders: readonly Substitution[]
  constructor(editedPlaceholders: readonly Substitution[]) {
    const count = editedPlaceholders.length
    const fields = editedPlaceholders.map((s) => s.path.join('.')).join(', ')
    super(
      `${count} truncated field${count === 1 ? '' : 's'} (${fields}) ` +
        `${count === 1 ? 'was' : 'were'} edited — the original data will be replaced by your typed text.`
    )
    this.name = 'PlaceholderEditedWarning'
    this.editedPlaceholders = editedPlaceholders
  }
}

// ---------------------------------------------------------------------------
// Keep logic
// ---------------------------------------------------------------------------

/** Read `field` off a resource as a string, or `null` when it is not one. */
const stringFieldOf = (resource: unknown, field: 'resourceType' | 'id'): string | null => {
  if (typeof resource !== 'object' || resource === null || !(field in resource)) return null
  const value: unknown = Reflect.get(resource, field)
  return typeof value === 'string' ? value : null
}

/**
 * Try to keep one edit: parse the text, restore any truncation
 * substitutions, decode as {@link FhirResourceSchema}, and refuse a
 * change to the two read-only fields.
 *
 * When `substitutions` are provided and the user has edited one or
 * more placeholders, returns `Left(PlaceholderEditedWarning)` unless
 * `force` is set — the caller can then re-invoke with `force: true`
 * after the reviewer confirms.
 *
 * @returns `Right` the decoded resource, or `Left` the error the banner
 *   should render — a `ParseError` for a schema failure, an
 *   {@link InvalidJsonError} for malformed JSON, a
 *   {@link PlaceholderEditedWarning} when truncated fields were edited,
 *   or an {@link ImmutableFieldChangedError} for an attempt to change
 *   `id` or `resourceType`.
 */
const tryKeep = (
  text: string,
  original: unknown,
  substitutions: readonly Substitution[] = [],
  options?: { readonly force?: boolean }
): Either.Either<FhirResource, unknown> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return Either.left(new InvalidJsonError(error))
  }
  const { restored, editedPlaceholders } = restoreSubstitutions(parsed, substitutions)
  if (editedPlaceholders.length > 0 && options?.force !== true) {
    return Either.left(new PlaceholderEditedWarning(editedPlaceholders))
  }
  const decoded = Schema.decodeUnknownEither(FhirResourceSchema)(restored)
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

export {
  ImmutableFieldChangedError,
  InvalidJsonError,
  PlaceholderEditedWarning,
  prettyPrintResource,
  restoreSubstitutions,
  TRUNCATION_THRESHOLD,
  tryKeep,
}
export type { RestoreResult, Substitution, TruncatedPrint }
