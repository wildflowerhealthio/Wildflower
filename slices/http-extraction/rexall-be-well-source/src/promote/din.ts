import { Array as Arr, Equivalence, Option, pipe, Schema, Struct } from 'effect'

import { CanadianCodingSystem, Code, Coding } from 'fhir-r4/data-types'
import { nonEmpty, whenPresent } from 'kitchen-sink'
import { modifyIfDecodes } from 'kitchen-sink/schema'

import { CarebookCodingSystem } from '../carebook.ts'
import { DecodedCodeableConcept } from './decoded-r4.ts'
import type { WireCodeableConcept, WireCoding } from './wire.ts'

/**
 * DIN twins: every vendor DIN coding ({@link CarebookCodingSystem.Din}) gains
 * exactly one canonical {@link CanadianCodingSystem.Din} coding carrying the
 * same `code`. Additive — the vendor coding stays, first.
 *
 * @remarks
 * Readers look for a DIN under the canonical system only (a vocabulary that is
 * not a DIN must never print as one), so a drug coded under the vendor system
 * alone shows no DIN at all. The vendor coding is kept for any reader that
 * already knows the vendor system.
 */

/** A DIN as a coding carries it: the code, and the display beside it, if any. */
interface Din {
  readonly code: string
  readonly display: string | null
}

/** Two DINs are the same drug product when their codes match; a display is only a label. */
const sameDinCode: Equivalence.Equivalence<Din> = Equivalence.mapInput(
  Equivalence.string,
  (din: Din) => din.code
)

/** A coding's DIN, when it carries a non-blank code. */
const dinOf = (coding: Coding.Type): Option.Option<Din> =>
  Option.map(Option.fromNullable(nonEmpty(coding.code)), (code) => ({
    code,
    display: nonEmpty(coding.display),
  }))

/** Every distinct DIN coded under `system`, in the order first coded. */
const dinsUnder =
  (system: string) =>
  (codings: readonly Coding.Type[]): readonly Din[] =>
    pipe(
      codings,
      Arr.filter(Coding.isInSystem(system)),
      Arr.filterMap(dinOf),
      Arr.dedupeWith(sameDinCode)
    )

/** The vendor DINs with no canonical twin yet: each is owed exactly one. */
const dinsOwedCanonicalTwin = (codings: readonly Coding.Type[]): readonly Din[] =>
  Arr.differenceWith(sameDinCode)(
    dinsUnder(CarebookCodingSystem.Din)(codings),
    dinsUnder(CanadianCodingSystem.Din)(codings)
  )

/** A DIN's canonical twin, as a decoded `Coding`. */
const canonicalDinCoding = ({ code, display }: Din): Coding.Type => ({
  id: null,
  extension: [],
  system: new URL(CanadianCodingSystem.Din),
  code: Code.make(code),
  display,
  userSelected: null,
  version: null,
})

/**
 * A DIN's canonical twin, as the raw wire coding a `contained` entry carries —
 * where an absent display is left out, since FHIR JSON has no `null` values.
 */
const wireCanonicalDinCoding = ({ code, display }: Din): WireCoding => ({
  system: CanadianCodingSystem.Din,
  code,
  ...(display === null ? {} : { display }),
})

/** A decoded `CodeableConcept` with its owed canonical DIN codings appended. */
const decodedConceptWithCanonicalDin = (concept: DecodedCodeableConcept): DecodedCodeableConcept =>
  Struct.evolve(concept, {
    coding: (codings) => [...codings, ...dinsOwedCanonicalTwin(codings).map(canonicalDinCoding)],
  })

/**
 * Re-reads a raw wire coding as a decoded R4 `Coding`, so the raw path picks
 * out DIN codings by the same {@link Coding.isInSystem} the decoded path uses.
 * A coding that does not decode is not read as a DIN.
 */
const decodeWireCoding = Schema.decodeUnknownOption(Coding.Schema)

/** Raw `CodeableConcept.coding` with its owed canonical DIN codings appended. */
const wireCodingsWithCanonicalDin = (wireCodings: readonly WireCoding[]): readonly WireCoding[] => [
  ...wireCodings,
  ...dinsOwedCanonicalTwin(
    Arr.filterMap(wireCodings, (wireCoding) => decodeWireCoding(wireCoding))
  ).map(wireCanonicalDinCoding),
]

/** A raw `CodeableConcept` with its owed canonical DIN codings appended. */
const wireConceptWithCanonicalDin = (concept: WireCodeableConcept): WireCodeableConcept =>
  Struct.evolve(concept, {
    coding: (wireCodings) => whenPresent(wireCodings, wireCodingsWithCanonicalDin),
  })

/**
 * Canonical DIN twins in a `medicationCodeableConcept` slot. The slot is
 * `any`-typed on the decoded resources; one that holds no decodable concept is
 * left as it is.
 */
const withCanonicalDinOnMedicationConcept = modifyIfDecodes(
  DecodedCodeableConcept,
  decodedConceptWithCanonicalDin
)

export { withCanonicalDinOnMedicationConcept, wireConceptWithCanonicalDin }
