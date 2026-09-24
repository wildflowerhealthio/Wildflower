import { Array as Arr, Option, ParseResult, pipe, Schema } from 'effect'

import {
  CanadianCodingSystem,
  Code,
  CodeableConcept,
  Extension,
  IdentifierAndReference,
  Ratio,
  WildflowerExtension,
} from 'fhir-r4/data-types'
import type { Quantity } from 'fhir-r4/data-types'
import type { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import { nonEmpty } from 'kitchen-sink'

import { CarebookCodingSystem, CarebookExtension, REXALL_SYSTEM_SOURCE } from './carebook.ts'

/**
 * Promotes carebook-dialect extensions into the conventional FHIR R4 fields
 * that already exist for them, on the R4 resources the `fhir-stu3-as-r4`
 * transform produces.
 *
 * @remarks
 * A **dialect post-step, deliberately outside `fhir-stu3-as-r4`**: that slice's
 * `R4FromStu3Schema` is bidirectional and its encode side rejects by name most
 * of what is written here, because STU3 has no slot for it. Promoting inside
 * that transform would make each promotion a round-trip invariant on a slice
 * whose job is *generic* STU3⇄R4.
 *
 * Each resource is promoted by a `pipe` of small `(resource) => resource`
 * steps. A step decodes the extension(s) it reads with a schema and, only once
 * the value has landed in its conventional slot, drops **exactly the entry it
 * read** in the same edit — never every entry that shares its url.
 *
 * The full table of what moves, what deliberately does not, why, and the traps
 * behind both rules above is in this package's AGENTS.md under "Extension
 * Promotion".
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** UCUM, the code system FHIR quantities use for units of measure. */
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/** UCUM code and display for a day, the unit Rexall's supply durations are in. */
const UCUM_DAY = { code: 'd', unit: 'day' } as const

/** The namespace FHIR R4 requires on a `Narrative.div`, which is typed `xhtml`. */
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

/** Base of the public Rexall store-locator page a store number is appended to. */
const REXALL_STORE_LOCATOR_BASE = 'https://www.rexall.ca/storelocator/store/'

/** The public store-locator URL for a Rexall store number. */
const rexallStoreLocatorUrl = (storeId: string): string =>
  `${REXALL_STORE_LOCATOR_BASE}${encodeURIComponent(storeId)}`

// ---------------------------------------------------------------------------
// Schemas — decoded R4 values (the `any`-typed choice slots)
// ---------------------------------------------------------------------------

/**
 * A decoded R4 `CodeableConcept`. `medication[x]` and `Extension.value[x]` are
 * `any` on the decoded resources, so these slots are re-read through this.
 */
const DecodedCodeableConcept = Schema.typeSchema(CodeableConcept.Schema)

/** A decoded R4 `Reference` — see {@link DecodedCodeableConcept}. */
const DecodedReference = Schema.typeSchema(IdentifierAndReference.ReferenceSchema)

const decodeCodeableConcept = Schema.decodeUnknownOption(DecodedCodeableConcept)
const decodeReference = Schema.decodeUnknownOption(DecodedReference)

// ---------------------------------------------------------------------------
// Schemas — carebook extensions on the decoded resources
// ---------------------------------------------------------------------------
//
// Each decodes a whole `Extension` straight to the one value it carries, so a
// step reads a `boolean` or a `Reference`, never an extension it must unpick.

/** `medicationrequest/…/do-not-perform`: the flag STU3 had no slot for. */
const DoNotPerform = Schema.pluck(Schema.Struct({ valueBoolean: Schema.Boolean }), 'valueBoolean')

/** `medicationrequest/…/request-type`: the `fill | refill` category. */
const RequestType = Schema.pluck(
  Schema.Struct({ valueCodeableConcept: DecodedCodeableConcept }),
  'valueCodeableConcept'
)

/** `…/medication-processor`: carebook's reference to the dispensing pharmacy location. */
const PharmacyLocationReference = Schema.pluck(
  Schema.Struct({ valueReference: DecodedReference }),
  'valueReference'
)

/**
 * `common/…/external-system-source`, only when it names Rexall. Any other
 * source is not a Rexall store and decodes to nothing.
 */
const RexallSystemSource = Schema.pluck(
  Schema.Struct({ valueString: Schema.Literal(REXALL_SYSTEM_SOURCE) }),
  'valueString'
)

/** `…/external-store-id`: a Rexall store number, trimmed, never blank. */
const ExternalStoreId = Schema.pluck(
  Schema.Struct({ valueString: Schema.compose(Schema.Trim, Schema.NonEmptyTrimmedString) }),
  'valueString'
)

/**
 * A remaining-repeats count: a non-negative *safe* integer. A fractional,
 * negative or out-of-range value is not a count, so its extension stays put.
 */
const SafeRepeatCount = Schema.NonNegativeInt

/** The `v1` remaining-repeats copy, a `positiveInt`. */
const RepeatsAvailableV1 = Schema.pluck(
  Schema.Struct({ valuePositiveInt: SafeRepeatCount }),
  'valuePositiveInt'
)

/** The `v2` remaining-repeats copy, the same number as a `decimal`. */
const RepeatsAvailableV2 = Schema.pluck(
  Schema.Struct({ valueDecimal: SafeRepeatCount }),
  'valueDecimal'
)

// ---------------------------------------------------------------------------
// Schemas — the raw `contained` Medication
// ---------------------------------------------------------------------------

/**
 * The rest of a raw wire object: every key a schema below does not name is
 * carried through untouched, so re-emitting a decoded entry loses nothing.
 */
const OtherWireFields = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/** An optional, nullable wire string — raw passthrough JSON may spell absence either way. */
const OptionalWireString = Schema.optional(Schema.NullOr(Schema.String))

/**
 * A raw `Coding`, as it sits inside `contained`.
 *
 * @remarks
 * Declared here rather than taken from `fhir-r4`'s `Coding.Schema`: the
 * contained entry is still wire JSON (`system` a string, not the decoded
 * `URL`), it may carry explicit `null`s, and keys the R4 schema does not model
 * must survive the round trip.
 */
const WireCoding = Schema.Struct(
  { system: OptionalWireString, code: OptionalWireString, display: OptionalWireString },
  OtherWireFields
)

/** A raw `CodeableConcept` — see {@link WireCoding} for why it is not `fhir-r4`'s. */
const WireCodeableConcept = Schema.Struct(
  { text: OptionalWireString, coding: Schema.optional(Schema.Array(WireCoding)) },
  OtherWireFields
)
type WireCodeableConcept = typeof WireCodeableConcept.Type

/** A raw `Narrative`, read only for its `div`. */
const WireNarrative = Schema.Struct({ div: OptionalWireString }, OtherWireFields)

/** A raw `Medication.ingredient` entry, read only for whether it names an `item[x]`. */
const WireIngredient = Schema.Struct(
  {
    itemCodeableConcept: Schema.optional(Schema.NullOr(OtherWireFields)),
    itemReference: Schema.optional(Schema.NullOr(OtherWireFields)),
  },
  OtherWireFields
)
type WireIngredient = typeof WireIngredient.Type

/** A leading decimal number (`.` only — see {@link StrengthRatioFromString}), then a unit word. */
const STRENGTH_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z/%.-]*)\s*$/

/**
 * `"10 mg"` / `"500MG"` → a wire `Ratio` of 10 mg per 1 unit of product.
 * Anything that is not a leading number followed by a unit word fails to
 * decode, so an unparseable strength keeps its extension instead of being
 * dropped.
 *
 * @remarks
 * `.` is the only decimal separator accepted. Rexall is an English-Canadian
 * pharmacy, where `"1,000 mg"` is one thousand milligrams written with a
 * thousands separator — reading that comma as a decimal point would silently
 * record a 1000× under-dose. Such a string simply fails to decode, which
 * leaves the extension in place with its true value intact.
 */
const StrengthRatioFromString = Schema.transformOrFail(
  Schema.String,
  Schema.encodedSchema(Ratio.Schema),
  {
    strict: true,
    decode: (raw, _, ast) => {
      const [, amount, unit] = STRENGTH_PATTERN.exec(raw) ?? []
      const value = Number(amount)
      return amount === undefined || unit === undefined || !Number.isFinite(value)
        ? ParseResult.fail(new ParseResult.Type(ast, raw, 'not a `<number> <unit>` strength'))
        : ParseResult.succeed({ numerator: { value, unit }, denominator: { value: 1 } })
    },
    encode: (ratio, _, ast) =>
      ratio.numerator?.value === undefined || ratio.numerator.unit === undefined
        ? ParseResult.fail(new ParseResult.Type(ast, ratio, 'a strength needs a value and a unit'))
        : ParseResult.succeed(`${ratio.numerator.value} ${ratio.numerator.unit}`),
  }
)

/** `medication/…/description` on a raw contained Medication, with a non-blank value. */
const DescriptionExtension = Schema.Struct({
  url: Schema.Literal(CarebookExtension.MedicationDescription),
  valueString: Schema.NonEmptyString,
})

/** `medication/…/strength` on a raw contained Medication, parsed to a `Ratio`. */
const StrengthExtension = Schema.Struct({
  url: Schema.Literal(CarebookExtension.MedicationStrength),
  valueString: StrengthRatioFromString,
})

/**
 * A raw `contained` Medication: the fields promotion reads, typed, and every
 * other key carried through as-is.
 *
 * @remarks
 * `extension` stays a list of unknown entries on purpose. Each entry is
 * decoded on its own by the step that looks for it, so one malformed entry
 * disables only itself instead of failing the whole Medication — and with it
 * every promotion on the drug that carries it.
 */
const ContainedMedication = Schema.Struct(
  {
    resourceType: Schema.Literal('Medication'),
    id: OptionalWireString,
    code: Schema.optional(Schema.NullOr(WireCodeableConcept)),
    text: Schema.optional(Schema.NullOr(WireNarrative)),
    extension: Schema.optional(Schema.Array(Schema.Unknown)),
    ingredient: Schema.optional(Schema.Array(WireIngredient)),
  },
  OtherWireFields
)
type ContainedMedication = typeof ContainedMedication.Type

const decodeContainedMedication = Schema.decodeUnknownOption(ContainedMedication)

// ---------------------------------------------------------------------------
// Schemas — DIN codings
// ---------------------------------------------------------------------------

/**
 * A coding under either DIN system — carebook's vendor one or the canonical
 * {@link CanadianCodingSystem.Din} — with its `system` as a plain string.
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

// ---------------------------------------------------------------------------
// Lifting extensions
// ---------------------------------------------------------------------------

/**
 * A value read off an extension list, together with the list as it is once
 * that value's entry is gone.
 *
 * @typeParam A - The decoded value
 * @typeParam E - The list's entry type: a decoded `Extension`, or a raw
 * `contained` entry
 */
interface Lifted<A, E = Extension.Type> {
  /** The value the entry carried, decoded. */
  readonly value: A
  /** The list with exactly that one entry removed — every other copy kept. */
  readonly remaining: readonly E[]
}

/**
 * Read the **first** extension at `url` through `schema`.
 *
 * @returns The decoded value and the list without that entry — or `None` when
 * there is no entry at `url` or the first one does not decode. A second copy is
 * never consulted: the dialect writes some urls twice, and only the first is
 * read.
 */
const liftExtension =
  <A, I>(url: string, schema: Schema.Schema<A, I>) =>
  (extensions: readonly Extension.Type[]): Option.Option<Lifted<A>> => {
    const decode = Schema.decodeUnknownOption(schema)
    return pipe(
      Arr.findFirst(extensions, (extension, index) =>
        extension.url === url ? Option.some({ extension, index }) : Option.none()
      ),
      Option.flatMap(({ extension, index }) =>
        Option.map(decode(extension), (value) => ({
          value,
          remaining: Arr.remove(extensions, index),
        }))
      )
    )
  }

/**
 * Read the first **raw** entry that decodes through `schema` — for a
 * `contained` Medication, whose extensions are unvalidated wire JSON and are
 * each decoded on their own.
 */
const liftRawExtension =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (entries: readonly unknown[]): Option.Option<Lifted<A, unknown>> => {
    const decode = Schema.decodeUnknownOption(schema)
    return pipe(
      Arr.findFirst(entries, (entry, index) =>
        Option.map(decode(entry), (value) => ({ value, index }))
      ),
      Option.map(({ value, index }) => ({ value, remaining: Arr.remove(entries, index) }))
    )
  }

/** A resource carrying an `extension` list. */
interface Extended {
  readonly extension: readonly Extension.Type[]
}

/**
 * A lift-and-drop step: read a value off `resource.extension` with `lift`,
 * `land` it, and — only if it landed — drop the entry it came from.
 *
 * @param lift - Reads the value, and the list as it is without the entries
 * the value came from
 * @param land - Writes the value into its conventional slot, or `None` when
 * the resource has no slot to hold it (the extension then stays)
 * @returns A `(resource) => resource` step for a `pipe`
 */
const promoteExtension =
  <R extends Extended, A>(
    lift: (extensions: readonly Extension.Type[]) => Option.Option<Lifted<A>>,
    land: (resource: R, value: A) => Option.Option<R>
  ) =>
  (resource: R): R =>
    pipe(
      lift(resource.extension),
      Option.flatMap(({ value, remaining }) =>
        Option.map(land(resource, value), (landed) => ({ ...landed, extension: remaining }))
      ),
      Option.getOrElse(() => resource)
    )

/**
 * The Rexall store-locator URL the `external-system-source` +
 * `external-store-id` pair spells, lifted as one value.
 *
 * @param externalStoreIdUrl - The resource's own `external-store-id` url
 * (request and dispense each have one)
 * @returns `None` unless the source reads {@link REXALL_SYSTEM_SOURCE} **and**
 * a non-blank store id is present — either one alone is not a store link, so a
 * lone extension is left where it is. Otherwise the URL, with both entries
 * gone from `remaining`.
 */
const liftStoreLocatorUrl =
  (externalStoreIdUrl: string) =>
  (extensions: readonly Extension.Type[]): Option.Option<Lifted<string>> =>
    pipe(
      liftExtension(CarebookExtension.ExternalSystemSource, RexallSystemSource)(extensions),
      Option.flatMap(({ remaining }) =>
        liftExtension(externalStoreIdUrl, ExternalStoreId)(remaining)
      ),
      Option.map(({ value: storeId, remaining }) => ({
        value: rexallStoreLocatorUrl(storeId),
        remaining,
      }))
    )

// ---------------------------------------------------------------------------
// Slot writers
// ---------------------------------------------------------------------------

/**
 * The pharmacy location reference pointed at the store-locator page, keeping
 * every other field of it — in particular the `identifier` carrying carebook's
 * own pharmacy id, which the store number must not displace.
 */
const withStoreLocatorUrl = (
  pharmacyLocationReference: IdentifierAndReference.ReferenceType | null,
  storeLocatorUrl: string
): IdentifierAndReference.ReferenceType => ({
  ...(pharmacyLocationReference ?? IdentifierAndReference.emptyReference),
  reference: storeLocatorUrl,
})

/**
 * Spell out the unit of a supply quantity Rexall sends bare. The dialect emits
 * `{ value }` with no `unit`/`system`/`code` on both
 * `dispenseRequest.expectedSupplyDuration` and `MedicationDispense.daysSupply`;
 * both are days. Only fills a quantity that carries a value and names no unit
 * of its own — a source that starts sending units is left alone.
 */
const withDayUnit = (quantity: Quantity.Type | null): Quantity.Type | null =>
  quantity === null || quantity.value === null || quantity.unit !== null || quantity.code !== null
    ? quantity
    : { ...quantity, unit: UCUM_DAY.unit, system: UCUM_SYSTEM, code: Code.make(UCUM_DAY.code) }

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * A conformant `Narrative.div` carrying `text`. R4 types `div` as `xhtml` and
 * requires it to be a single `<div>` in the XHTML namespace, so a bare string
 * is not a legal narrative however readable it looks — a conformant server
 * rejects it on write.
 */
const narrativeDiv = (text: string): string =>
  `<div xmlns="${XHTML_NAMESPACE}">${text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char)}</div>`

/** The display-bearing fields shared by a decoded and a raw `CodeableConcept`. */
interface Displayable {
  readonly text?: string | null | undefined
  readonly coding?: readonly { readonly display?: string | null | undefined }[] | undefined
}

/** A concept's best human-readable label: its `text`, else the first coding `display`. */
const conceptDisplay = (concept: Displayable): string | null =>
  nonEmpty(concept.text) ??
  pipe(
    Arr.findFirst(concept.coding ?? [], (coding) => Option.fromNullable(nonEmpty(coding.display))),
    Option.getOrNull
  )

// ---------------------------------------------------------------------------
// DIN twins
// ---------------------------------------------------------------------------

/**
 * The canonical {@link CanadianCodingSystem.Din} codings a concept is missing:
 * one per distinct vendor DIN code ({@link CarebookCodingSystem.Din}) that has
 * no canonical twin yet. Additive — the vendor coding stays beside it.
 */
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
  concept: typeof DecodedCodeableConcept.Type
): Option.Option<typeof DecodedCodeableConcept.Type> => {
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

// ---------------------------------------------------------------------------
// Contained Medication steps
// ---------------------------------------------------------------------------

/** Give the contained Medication's vendor DIN coding a canonical twin. */
const withContainedCanonicalDin = (medication: ContainedMedication): ContainedMedication =>
  medication.code === undefined || medication.code === null
    ? medication
    : { ...medication, code: wireConceptWithCanonicalDin(medication.code) }

/**
 * Whether the description may take over the Medication's narrative: only when
 * there is none, or when all that is there is the dialect's byte-copy of
 * `code.text`.
 *
 * @remarks
 * The copy is what makes the narrative free real estate — the description is
 * strictly richer than the same string. A narrative holding anything *else* is
 * somebody's real content, so the promotion stands down and (per the
 * lift-and-drop rule) the description extension stays where it is.
 */
const narrativeIsReplaceable = (medication: ContainedMedication): boolean => {
  const div = medication.text?.div
  return div === undefined || div === null || div === nonEmpty(medication.code?.text)
}

/** `description` → a conformant XHTML narrative, when the narrative is free. */
const liftDescription = (medication: ContainedMedication): ContainedMedication =>
  narrativeIsReplaceable(medication)
    ? pipe(
        liftRawExtension(DescriptionExtension)(medication.extension ?? []),
        Option.match({
          onNone: () => medication,
          onSome: ({ value, remaining }) => ({
            ...medication,
            extension: remaining,
            text: { status: 'generated', div: narrativeDiv(value.valueString) },
          }),
        })
      )
    : medication

/**
 * `strength` merged into `ingredient[0]`, keeping every other ingredient and
 * every other key of the first one. A compounded prescription carries several
 * ingredients, and replacing the array outright would delete them.
 *
 * R4 requires `ingredient.item[x]`, so a slot created from nothing names the
 * Medication's own `code` as the item — the strength is a strength *of* this
 * drug.
 */
const withStrength = (
  ingredients: readonly WireIngredient[],
  code: WireCodeableConcept,
  strength: typeof StrengthRatioFromString.Type
): readonly WireIngredient[] => {
  const first: WireIngredient = ingredients[0] ?? {}
  const namesItem = first.itemCodeableConcept !== undefined || first.itemReference !== undefined
  return [
    { ...first, ...(namesItem ? {} : { itemCodeableConcept: code }), strength },
    ...ingredients.slice(1),
  ]
}

/**
 * `strength` → `ingredient[0].strength`, when it parses and there is a `code`
 * to name the ingredient by.
 */
const liftStrength = (medication: ContainedMedication): ContainedMedication => {
  const code = medication.code
  if (code === undefined || code === null) return medication
  return pipe(
    liftRawExtension(StrengthExtension)(medication.extension ?? []),
    Option.match({
      onNone: () => medication,
      onSome: ({ value, remaining }) => ({
        ...medication,
        extension: remaining,
        ingredient: withStrength(medication.ingredient ?? [], code, value.valueString),
      }),
    })
  )
}

/**
 * Promote one `contained` entry, if it is a Medication: a canonical DIN twin
 * on its `code`, `description` → the narrative, `strength` →
 * `ingredient[0].strength`.
 *
 * @remarks
 * `contained` is untyped passthrough on the decoded resource, so this is the
 * schema boundary: an entry that does not decode as a
 * {@link ContainedMedication} — another resource type, or a malformed one —
 * comes back exactly as it went in.
 */
const promoteContainedEntry = (entry: unknown): unknown =>
  pipe(
    decodeContainedMedication(entry),
    Option.map((medication) =>
      pipe(medication, withContainedCanonicalDin, liftDescription, liftStrength)
    ),
    Option.getOrElse(() => entry)
  )

/** Run {@link promoteContainedEntry} over every `contained` entry. */
const promoteContained = <R extends { readonly contained: readonly unknown[] }>(
  resource: R
): R => ({
  ...resource,
  contained: resource.contained.map(promoteContainedEntry),
})

// ---------------------------------------------------------------------------
// MedicationRequest steps
// ---------------------------------------------------------------------------

/** A `MedicationRequest.dispenseRequest`, present. */
type DispenseRequest = NonNullable<MedicationRequest.Type['dispenseRequest']>

/**
 * Put `performer` on the request's `dispenseRequest` — or `None` when it has
 * none. `dispenseRequest` is optional in the dialect, and a value with nowhere
 * to land must keep its extension (dropping it would destroy the dispensing
 * pharmacy, or the store number, outright).
 */
const withDispensePerformer = (
  request: MedicationRequest.Type,
  performerFrom: (
    currentPerformer: IdentifierAndReference.ReferenceType | null
  ) => IdentifierAndReference.ReferenceType
): Option.Option<MedicationRequest.Type> =>
  request.dispenseRequest === null
    ? Option.none()
    : Option.some({
        ...request,
        dispenseRequest: {
          ...request.dispenseRequest,
          performer: performerFrom(request.dispenseRequest.performer),
        },
      })

/** `do-not-perform` → `doNotPerform`. */
const liftDoNotPerform = promoteExtension(
  liftExtension(CarebookExtension.DoNotPerform, DoNotPerform),
  (request: MedicationRequest.Type, doNotPerform) => Option.some({ ...request, doNotPerform })
)

/** `request-type` → appended to `category`. */
const liftRequestType = promoteExtension(
  liftExtension(CarebookExtension.RequestType, RequestType),
  (request: MedicationRequest.Type, requestType) =>
    Option.some({ ...request, category: [...request.category, requestType] })
)

/** `medication-processor` → `dispenseRequest.performer`. */
const liftRequestMedicationProcessor = promoteExtension(
  liftExtension(CarebookExtension.RequestMedicationProcessor, PharmacyLocationReference),
  (request: MedicationRequest.Type, pharmacyLocationReference) =>
    withDispensePerformer(request, () => pharmacyLocationReference)
)

/**
 * The store pair → `dispenseRequest.performer.reference`, creating the
 * performer when no `medication-processor` supplied one (the capture's
 * `mr-0002`). Runs after {@link liftRequestMedicationProcessor}, so a
 * processor's pharmacy identifier is already in place to keep.
 */
const liftRequestStoreLocatorUrl = promoteExtension(
  liftStoreLocatorUrl(CarebookExtension.RequestExternalStoreId),
  (request: MedicationRequest.Type, storeLocatorUrl) =>
    withDispensePerformer(request, (pharmacyLocationReference) =>
      withStoreLocatorUrl(pharmacyLocationReference, storeLocatorUrl)
    )
)

/**
 * A {@link WildflowerExtension.RepeatsAvailable} entry holding `count`, unless
 * the list already carries one.
 */
const withRepeatsAvailable = (
  extensions: readonly Extension.Type[],
  count: number
): readonly Extension.Type[] =>
  extensions.some((extension) => extension.url === WildflowerExtension.RepeatsAvailable)
    ? extensions
    : [
        ...extensions,
        {
          ...Extension.emptyValueChoice,
          id: null,
          extension: [],
          url: WildflowerExtension.RepeatsAvailable,
          valueInteger: count,
        },
      ]

/** Reads the first `v1` remaining-repeats copy. */
const liftRepeatsAvailableV1 = liftExtension(
  CarebookExtension.NumberOfRepeatsAvailable,
  RepeatsAvailableV1
)

/** Reads the first `v2` remaining-repeats copy. */
const liftRepeatsAvailableV2 = liftExtension(
  CarebookExtension.NumberOfRepeatsAvailableV2,
  RepeatsAvailableV2
)

/**
 * Drop the copy `lift` reads only if it carries exactly `count` — a copy that
 * disagrees with the promoted number is a value nobody promoted, and stays.
 */
const withoutCopyCarrying =
  (lift: (extensions: readonly Extension.Type[]) => Option.Option<Lifted<number>>, count: number) =>
  (extensions: readonly Extension.Type[]): readonly Extension.Type[] =>
    pipe(
      lift(extensions),
      Option.filter(({ value }) => value === count),
      Option.match({ onNone: () => extensions, onSome: ({ remaining }) => remaining })
    )

/**
 * The dialect's remaining-repeats `modifierExtension` pair → a single
 * {@link WildflowerExtension.RepeatsAvailable} `valueInteger` on the dispense
 * request's `extension`.
 *
 * @remarks
 * `v1` (`valuePositiveInt`) is preferred, `v2` (`valueDecimal`) the fallback;
 * each copy is dropped only when it carries the promoted number — see
 * AGENTS.md under "Extension Promotion".
 */
const promoteRepeatsAvailable = (dispenseRequest: DispenseRequest): DispenseRequest =>
  pipe(
    liftRepeatsAvailableV1(dispenseRequest.modifierExtension),
    Option.orElse(() => liftRepeatsAvailableV2(dispenseRequest.modifierExtension)),
    Option.match({
      onNone: () => dispenseRequest,
      onSome: ({ value: count }) => ({
        ...dispenseRequest,
        modifierExtension: pipe(
          dispenseRequest.modifierExtension,
          withoutCopyCarrying(liftRepeatsAvailableV1, count),
          withoutCopyCarrying(liftRepeatsAvailableV2, count)
        ),
        extension: withRepeatsAvailable(dispenseRequest.extension, count),
      }),
    })
  )

/** The UCUM day unit on a bare `expectedSupplyDuration`. */
const withSupplyDurationInDays = (dispenseRequest: DispenseRequest): DispenseRequest => ({
  ...dispenseRequest,
  expectedSupplyDuration: withDayUnit(dispenseRequest.expectedSupplyDuration),
})

/** The `dispenseRequest`-local promotions, when there is a `dispenseRequest`. */
const promoteDispenseRequest = (request: MedicationRequest.Type): MedicationRequest.Type =>
  request.dispenseRequest === null
    ? request
    : {
        ...request,
        dispenseRequest: pipe(
          request.dispenseRequest,
          withSupplyDurationInDays,
          promoteRepeatsAvailable
        ),
      }

/** Where a contained Medication can be linked from: its `id`, and the best label its `code` offers. */
interface ContainedMedicationLink {
  readonly id: string
  readonly display: string | null
}

/** The link to a contained Medication, when it has both a usable `code` and an `id`. */
const containedMedicationLink = (entry: unknown): Option.Option<ContainedMedicationLink> =>
  pipe(
    decodeContainedMedication(entry),
    Option.flatMap(({ id, code }) => {
      const linkId = nonEmpty(id)
      return code === undefined || code === null || linkId === null
        ? Option.none()
        : Option.some({ id: linkId, display: conceptDisplay(code) })
    })
  )

/**
 * Link the orphaned `contained` Medication by `medicationReference: '#id'`.
 *
 * @remarks
 * Nothing points at it today, so its form, manufacturer, strength and
 * description are unreachable. `medication[x]` is a choice, so the inline
 * `medicationCodeableConcept` gives way — but its label does not: whatever name
 * the existing reference, the concept, or the contained `code` carried is
 * copied onto the reference's `display`, so a reader that only knows how to
 * render `medication[x]` still has a name to show.
 *
 * The link is skipped when `medicationReference` already points somewhere that
 * is not a `#fragment`: that is an external Medication nobody here may
 * retarget.
 */
const linkContainedMedication = (request: MedicationRequest.Type): MedicationRequest.Type => {
  const medicationReference = Option.getOrNull(decodeReference(request.medicationReference))
  const existingTarget = nonEmpty(medicationReference?.reference)
  if (existingTarget !== null && !existingTarget.startsWith('#')) return request
  return pipe(
    Arr.findFirst(request.contained, containedMedicationLink),
    Option.match({
      onNone: () => request,
      onSome: (link) => ({
        ...request,
        medicationReference: {
          ...(medicationReference ?? IdentifierAndReference.emptyReference),
          reference: `#${link.id}`,
          display:
            nonEmpty(medicationReference?.display) ??
            Option.getOrNull(
              Option.map(decodeCodeableConcept(request.medicationCodeableConcept), conceptDisplay)
            ) ??
            link.display,
        },
        medicationCodeableConcept: null,
      }),
    })
  )
}

/**
 * Promote a carebook `MedicationRequest`: `do-not-perform` → `doNotPerform`,
 * `request-type` → `category`, `medication-processor` →
 * `dispenseRequest.performer`, `external-system-source` + `external-store-id` →
 * the store-locator URL on `dispenseRequest.performer.reference`, the
 * remaining-repeats `modifierExtension` pair → one
 * {@link WildflowerExtension.RepeatsAvailable}, a canonical DIN coding beside
 * the vendor one, the UCUM day unit onto `expectedSupplyDuration`, and the
 * orphaned contained Medication linked as `medication[x]`.
 */
const promoteMedicationRequest = (request: MedicationRequest.Type): MedicationRequest.Type =>
  pipe(
    request,
    liftDoNotPerform,
    liftRequestType,
    liftRequestMedicationProcessor,
    liftRequestStoreLocatorUrl,
    promoteContained,
    withCanonicalDinOnMedicationConcept,
    linkContainedMedication,
    promoteDispenseRequest
  )

// ---------------------------------------------------------------------------
// MedicationDispense steps
// ---------------------------------------------------------------------------

/** `medication-processor` → `location`, which a dispense always has room for. */
const liftDispenseMedicationProcessor = promoteExtension(
  liftExtension(CarebookExtension.DispenseMedicationProcessor, PharmacyLocationReference),
  (dispense: MedicationDispense.Type, pharmacyLocationReference) =>
    Option.some({ ...dispense, location: pharmacyLocationReference })
)

/** The store pair → `location.reference`, mirroring the request's `performer`. */
const liftDispenseStoreLocatorUrl = promoteExtension(
  liftStoreLocatorUrl(CarebookExtension.DispenseExternalStoreId),
  (dispense: MedicationDispense.Type, storeLocatorUrl) =>
    Option.some({ ...dispense, location: withStoreLocatorUrl(dispense.location, storeLocatorUrl) })
)

/** The UCUM day unit on a bare `daysSupply`. */
const withDaysSupplyInDays = (dispense: MedicationDispense.Type): MedicationDispense.Type => ({
  ...dispense,
  daysSupply: withDayUnit(dispense.daysSupply),
})

/**
 * Promote a carebook `MedicationDispense`: `medication-processor` → `location`,
 * `external-system-source` + `external-store-id` → the store-locator URL on
 * `location.reference` (mirroring the request's `dispenseRequest.performer`), a
 * canonical DIN coding beside the vendor one, the UCUM day unit onto
 * `daysSupply`, and the same contained-Medication promotions the request path
 * performs.
 *
 * @remarks
 * `location` rather than `performer` because the reference denotes a
 * `Location`: the request path is `…/pharmacy/Location` and the extension's id
 * is that query's `_id`.
 *
 * The `contained` pass is symmetry with the request path rather than an
 * observed need — see AGENTS.md under "Extension Promotion".
 */
const promoteMedicationDispense = (dispense: MedicationDispense.Type): MedicationDispense.Type =>
  pipe(
    dispense,
    liftDispenseMedicationProcessor,
    liftDispenseStoreLocatorUrl,
    promoteContained,
    withCanonicalDinOnMedicationConcept,
    withDaysSupplyInDays
  )

export { promoteMedicationDispense, promoteMedicationRequest }
