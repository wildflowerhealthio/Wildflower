import { Arbitrary, Either, Schema } from 'effect'
import type * as fc from 'fast-check'
import { CodeableConcept } from 'fhir-r4/data-types'

/**
 * Any decoded `CodeableConcept` — a foreign concept a reader must refuse or
 * ignore, never misread.
 */
const foreignConceptArb: fc.Arbitrary<typeof CodeableConcept.Schema.Type> = Arbitrary.make(
  CodeableConcept.Schema
)

/** A resource encoded to wire JSON and decoded back, as a server round-trip leaves it. */
const throughWire = <A, I>(schema: Schema.Schema<A, I>, resource: A): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(resource))))

/** The problems of a refused read, or none when it was accepted. */
const problemsOf = <A, P>(
  read: Either.Either<A, { readonly problems: readonly P[] }>
): readonly P[] => Either.match(read, { onLeft: (refused) => refused.problems, onRight: () => [] })

export { foreignConceptArb, problemsOf, throughWire }
