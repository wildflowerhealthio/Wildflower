/**
 * A typed FHIR reference to a source file's `DocumentReference`, carrying the
 * invariant that the string is `DocumentReference/<non-empty id>` at the type
 * level.
 *
 * @packageDocumentation
 */

const PREFIX = 'DocumentReference/'

type SourceFileFhirReference = `DocumentReference/${string}`

const make = (id: string): SourceFileFhirReference => `${PREFIX}${id}`

const idOf = (ref: SourceFileFhirReference): string => ref.slice(PREFIX.length)

const is = (value: string): value is SourceFileFhirReference =>
  value.startsWith(PREFIX) && value.length > PREFIX.length

export { type SourceFileFhirReference, idOf, is, make }
