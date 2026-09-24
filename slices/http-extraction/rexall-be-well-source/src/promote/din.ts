import { Array as Arr, Option, pipe, Schema } from 'effect'

import { CanadianCodingSystem, Code } from 'fhir-r4/data-types'
import { nonEmpty } from 'kitchen-sink'

import { CarebookCodingSystem } from '../carebook.ts'
import { type DecodedCodeableConcept, decodeCodeableConcept } from './decoded-r4.ts'
import { OptionalWireString, type WireCodeableConcept } from './wire.ts'

/**
 * DIN twins: every vendor DIN coding ({@link CarebookCodingSystem.Din}) gains
 * exactly one canonical {@link CanadianCodingSystem.Din} coding carrying the
 * same `code`. Additive — the vendor coding stays, first.
 */

/**
 * A coding under either DIN system, with its `system` as a plain string.
 * Every other coding fails to decode and is ignored.
 */
const DinCoding = Schema.Struct({
  system: Schema.Literal(CarebookCodingSystem.Din, CanadianCodingSystem.Din),
  code: Schema.NonEmptyString,
  display: OptionalWireString,
})
type DinCoding = typeof DinCoding.Type

const decodeDinCoding = Schema.decodeUnknownOption(DinCoding)

/** A vendor DIN that has no canonical twin yet: the code, and its display if any. */
interface MissingCanonicalDin {
  readonly code: string
  readonly display: string | null
}

/** One entry per distinct vendor DIN code that has no canonical twin yet. */
const canonicalDinsMissingFrom = (
  dinCodings: readonly DinCoding[]
): readonly MissingCanonicalDin[] => {
  const canonicalCodes = new Set(
    dinCodings
      .filter((coding) => coding.system === CanadianCodingSystem.Din)
      .map((coding) => coding.code)
  )
  return Arr.dedupeWith(
    dinCodings.filter((coding) => coding.system === CarebookCodingSystem.Din),
    (a, b) => a.code === b.code
  )
    .filter((coding) => !canonicalCodes.has(coding.code))
    .map((coding) => ({ code: coding.code, display: nonEmpty(coding.display) }))
}

/**
 * A decoded `CodeableConcept` with its missing canonical DIN codings appended,
 * or `None` when it is missing none.
 */
const decodedConceptWithCanonicalDin = (
  concept: DecodedCodeableConcept
): Option.Option<DecodedCodeableConcept> => {
  const missing = canonicalDinsMissingFrom(
    Arr.getSomes(
      concept.coding.map((coding) =>
        decodeDinCoding({
          system: coding.system?.href,
          code: coding.code,
          display: coding.display,
        })
      )
    )
  )
  return missing.length === 0
    ? Option.none()
    : Option.some({
        ...concept,
        coding: [
          ...concept.coding,
          ...missing.map(({ code, display }) => ({
            id: null,
            extension: [],
            system: new URL(CanadianCodingSystem.Din),
            code: Code.make(code),
            display,
            userSelected: null,
            version: null,
          })),
        ],
      })
}

/** A raw `CodeableConcept` with its missing canonical DIN codings appended. */
const wireConceptWithCanonicalDin = (concept: WireCodeableConcept): WireCodeableConcept => {
  const codings = concept.coding ?? []
  const missing = canonicalDinsMissingFrom(
    Arr.getSomes(codings.map((coding) => decodeDinCoding(coding)))
  )
  return missing.length === 0
    ? concept
    : {
        ...concept,
        coding: [
          ...codings,
          ...missing.map(({ code, display }) => ({
            system: CanadianCodingSystem.Din,
            code,
            ...(display === null ? {} : { display }),
          })),
        ],
      }
}

/**
 * Give the vendor DIN codings on `medicationCodeableConcept` their canonical
 * twins. A slot that holds no decodable concept is left as it is.
 */
const withCanonicalDinOnMedicationConcept = <
  R extends { readonly medicationCodeableConcept: unknown },
>(
  resource: R
): R =>
  pipe(
    decodeCodeableConcept(resource.medicationCodeableConcept),
    Option.flatMap(decodedConceptWithCanonicalDin),
    Option.match({
      onNone: () => resource,
      onSome: (medicationCodeableConcept) => ({ ...resource, medicationCodeableConcept }),
    })
  )

export { withCanonicalDinOnMedicationConcept, wireConceptWithCanonicalDin }
