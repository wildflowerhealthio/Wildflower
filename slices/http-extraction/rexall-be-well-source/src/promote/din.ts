import { Array as Arr, Equivalence, Option, pipe, String as Str, Struct } from 'effect'

import { CanadianCodingSystem, Code, Coding } from 'fhir-r4/data-types'
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
  readonly display: Option.Option<string>
}

/** Two DINs are the same drug product when their codes match; a display is only a label. */
const sameDinCode: Equivalence.Equivalence<Din> = Equivalence.mapInput(
  Equivalence.string,
  (din: Din) => din.code
)

/** The DIN a coding's `code` and `display` spell, when the code is non-blank. */
const dinOf = (code: Option.Option<string>, display: Option.Option<string>): Option.Option<Din> =>
  Option.map(Option.filter(code, Str.isNonEmpty), (dinCode) => ({
    code: dinCode,
    display: Option.filter(display, Str.isNonEmpty),
  }))

/** How to read a DIN off one kind of coding, when it is coded under `system`. */
type DinUnder<C> = (system: string) => (coding: C) => Option.Option<Din>

/**
 * The vendor DINs with no canonical twin yet — each is owed exactly one — read
 * off `codings` by `dinUnder`, so decoded and raw codings follow one rule.
 */
const dinsOwedCanonicalTwin =
  <C>(dinUnder: DinUnder<C>) =>
  (codings: readonly C[]): readonly Din[] => {
    const distinctDinsUnder = (system: string): readonly Din[] =>
      Arr.dedupeWith(Arr.filterMap(codings, dinUnder(system)), sameDinCode)
    return Arr.differenceWith(sameDinCode)(
      distinctDinsUnder(CarebookCodingSystem.Din),
      distinctDinsUnder(CanadianCodingSystem.Din)
    )
  }

/** A decoded coding's DIN under `system`. */
const decodedDinUnder: DinUnder<Coding.Type> = (system) => (coding) =>
  pipe(
    coding,
    Option.liftPredicate(Coding.isInSystem(system)),
    Option.flatMap(({ code, display }) =>
      dinOf(Option.fromNullable(code), Option.fromNullable(display))
    )
  )

const parseUrl = Option.liftThrowable((system: string) => new URL(system))

/**
 * Whether a raw coding is under `system`, compared by `href` exactly as
 * {@link Coding.isInSystem} compares a decoded one.
 */
const wireCodingIsInSystem =
  (system: string) =>
  (wireCoding: WireCoding): boolean =>
    Option.exists(Option.flatMap(wireCoding.system, parseUrl), ({ href }) => href === system)

/** A raw coding's DIN under `system`. */
const wireDinUnder: DinUnder<WireCoding> = (system) => (wireCoding) =>
  pipe(
    wireCoding,
    Option.liftPredicate(wireCodingIsInSystem(system)),
    Option.flatMap(({ code, display }) => dinOf(code, display))
  )

/** A DIN's canonical twin, as a decoded `Coding`. */
const canonicalDinCoding = ({ code, display }: Din): Coding.Type => ({
  id: null,
  extension: [],
  system: new URL(CanadianCodingSystem.Din),
  code: Code.make(code),
  display: Option.getOrNull(display),
  userSelected: null,
  version: null,
})

/** A DIN's canonical twin, as the raw wire coding a `contained` entry carries. */
const wireCanonicalDinCoding = ({ code, display }: Din): WireCoding => ({
  system: Option.some(CanadianCodingSystem.Din),
  code: Option.some(code),
  display,
})

/** A decoded `CodeableConcept` with its owed canonical DIN codings appended. */
const decodedConceptWithCanonicalDin = (concept: DecodedCodeableConcept): DecodedCodeableConcept =>
  Struct.evolve(concept, {
    coding: (codings) => [
      ...codings,
      ...dinsOwedCanonicalTwin(decodedDinUnder)(codings).map(canonicalDinCoding),
    ],
  })

/** Raw `CodeableConcept.coding` with its owed canonical DIN codings appended. */
const wireCodingsWithCanonicalDin = (wireCodings: readonly WireCoding[]): readonly WireCoding[] => [
  ...wireCodings,
  ...dinsOwedCanonicalTwin(wireDinUnder)(wireCodings).map(wireCanonicalDinCoding),
]

/** A raw `CodeableConcept` with its owed canonical DIN codings appended. */
const wireConceptWithCanonicalDin = (concept: WireCodeableConcept): WireCodeableConcept =>
  Struct.evolve(concept, {
    coding: Option.map(wireCodingsWithCanonicalDin),
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
