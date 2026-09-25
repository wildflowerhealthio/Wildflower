import { Array as Arr, flow, Option, pipe, Schema, String as Str, Struct } from 'effect'

import {
  CodeableConcept,
  IdentifierAndReference,
  Narrative,
  WildflowerExtension,
} from 'fhir-r4/data-types'
import type { MedicationRequest } from 'fhir-r4/resources'
import { Lift } from 'kitchen-sink'
import { modifyIfDecodes } from 'kitchen-sink/schema'

import { CarebookExtension } from '../carebook.ts'
import { decodeCodeableConcept, decodeReference } from './decoded-r4.ts'
import { wireConceptWithCanonicalDin } from './din.ts'
import { promoteExtension } from './extension-lift.ts'
import { StrengthRatioFromString } from './strength-ratio.ts'
import { OtherWireFields, WireCodeableConcept, WireStringOption } from './wire.ts'

/**
 * The `contained` Medication: promoted in place (a canonical DIN twin on its
 * `code`, `description` → the narrative, `strength` → `ingredient[0].strength`),
 * and linked from the request's `medication[x]`, which the dialect leaves
 * pointing nowhere.
 *
 * @remarks
 * `contained` is untyped passthrough on the decoded resources, so this module
 * is the schema boundary: each entry is decoded once against
 * {@link ContainedMedication}, and one that does not decode — another resource
 * type, or a malformed Medication — comes back exactly as it went in.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** A raw `Narrative`, read only for its `div`. */
const WireNarrative = Schema.Struct({ div: WireStringOption }, OtherWireFields)

/** A raw `Medication.ingredient` entry, read only for whether it names an `item[x]`. */
const WireIngredient = Schema.Struct(
  {
    itemCodeableConcept: Schema.optionalWith(WireCodeableConcept, { nullable: true, as: 'Option' }),
    itemReference: Schema.optionalWith(OtherWireFields, { nullable: true, as: 'Option' }),
  },
  OtherWireFields
)
type WireIngredient = typeof WireIngredient.Type

// Raw extensions decode whole, `url` included — never `Schema.pluck` (see AGENTS.md, "Extension Promotion").

/** `medication/…/description`: carebook's label for the drug, with non-blank text. */
const DescriptionExtension = Schema.Struct({
  url: Schema.Literal(CarebookExtension.MedicationDescription),
  valueString: Schema.NonEmptyString,
})

/** `medication/…/strength`: free text such as `"10 mg"`, read to a `Ratio`. */
const StrengthExtension = Schema.Struct({
  url: Schema.Literal(CarebookExtension.MedicationStrength),
  valueString: StrengthRatioFromString,
})
type Strength = typeof StrengthRatioFromString.Type

/** The description's text, off the first raw entry that is one. */
const liftDescriptionText = pipe(
  Lift.firstDecoding(DescriptionExtension),
  Lift.map(({ valueString }) => valueString)
)

/** The parsed strength, off the first raw entry that is one. */
const liftStrengthRatio = pipe(
  Lift.firstDecoding(StrengthExtension),
  Lift.map(({ valueString }) => valueString)
)

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
    id: WireStringOption,
    code: Schema.optionalWith(WireCodeableConcept, { nullable: true, as: 'Option' }),
    text: Schema.optionalWith(WireNarrative, { nullable: true, as: 'Option' }),
    extension: Schema.optional(Schema.Array(Schema.Unknown)),
    ingredient: Schema.optional(Schema.Array(WireIngredient)),
  },
  OtherWireFields
)
type ContainedMedication = typeof ContainedMedication.Type

const decodeContainedMedication = Schema.decodeUnknownOption(ContainedMedication)

const encodeNarrativeDiv = Schema.encodeSync(Narrative.TextFromDiv)

/**
 * A raw concept's label, by the rule `fhir-r4`'s {@link CodeableConcept.label}
 * reads a decoded one with: its `text`, else the first coding's `display`, a
 * blank value counting as absent.
 */
const wireConceptLabel = (concept: WireCodeableConcept): Option.Option<string> =>
  pipe(
    [
      concept.text,
      ...Arr.map(Option.getOrElse(concept.coding, Arr.empty), ({ display }) => display),
    ],
    Arr.map(Option.filter(Str.isNonEmpty)),
    Option.firstSomeOf
  )

// ---------------------------------------------------------------------------
// Promotions on one contained Medication
// ---------------------------------------------------------------------------

/**
 * A canonical DIN twin beside the vendor DIN coding on the Medication's
 * `code`, which is where a reader looks for the drug's DIN first.
 */
const withContainedCanonicalDin = (medication: ContainedMedication): ContainedMedication =>
  Struct.evolve(medication, { code: Option.map(wireConceptWithCanonicalDin) })

/**
 * Whether the description may take over the Medication's narrative: only when
 * there is none, or when all that is there is the dialect's byte-copy of
 * `code.text`.
 *
 * @remarks
 * The copy is what makes the narrative free real estate — the description is
 * strictly richer than the same string. A narrative holding anything *else* is
 * somebody's real content, which the description must not overwrite.
 */
const narrativeIsReplaceable = (medication: ContainedMedication): boolean =>
  Option.match(
    Option.flatMap(medication.text, ({ div }) => div),
    {
      onNone: () => true,
      onSome: (div) =>
        pipe(
          medication.code,
          Option.flatMap(({ text }) => text),
          Option.filter(Str.isNonEmpty),
          Option.exists((codeText) => codeText === div)
        ),
    }
  )

/** The Medication with `description` as its narrative, a conformant XHTML `div`. */
const withDescriptionNarrative = (
  medication: ContainedMedication,
  description: string
): ContainedMedication => ({
  ...medication,
  text: Option.some({ status: 'generated', div: Option.some(encodeNarrativeDiv(description)) }),
})

/**
 * The Medication with `description` on the Wildflower description extension —
 * the slot for a description whose natural home, the narrative, is taken.
 */
const withDescriptionExtension = (
  medication: ContainedMedication,
  description: string
): ContainedMedication => ({
  ...medication,
  extension: [
    ...(medication.extension ?? []),
    { url: WildflowerExtension.MedicationDescription, valueString: description },
  ],
})

/**
 * `description` → the narrative when it is free, else the Wildflower
 * description extension. Either way the carebook extension goes, so a reader
 * needs no vendor url to find the description.
 */
const liftDescription = promoteExtension(
  liftDescriptionText,
  (medication: ContainedMedication, description) =>
    Option.some(
      narrativeIsReplaceable(medication)
        ? withDescriptionNarrative(medication, description)
        : withDescriptionExtension(medication, description)
    )
)

/** Whether an ingredient already says which item it is an ingredient of. */
const namesItem = (ingredient: WireIngredient): boolean =>
  Option.isSome(ingredient.itemCodeableConcept) || Option.isSome(ingredient.itemReference)

/** An ingredient that names no item yet. */
const itemlessIngredient: WireIngredient = {
  itemCodeableConcept: Option.none(),
  itemReference: Option.none(),
}

/**
 * The ingredient, naming `code` as its item when it names none. R4 requires
 * `ingredient.item[x]`, and a strength with no item is a strength of nothing;
 * the strength is a strength *of this drug*, so the drug's own code is the item.
 */
const namingItemAs =
  (code: WireCodeableConcept) =>
  (ingredient: WireIngredient): WireIngredient =>
    namesItem(ingredient) ? ingredient : { ...ingredient, itemCodeableConcept: Option.some(code) }

/**
 * `strength` merged into the first ingredient, keeping every other ingredient
 * and every other key of the first one. A compounded prescription carries
 * several ingredients, and replacing the list outright would delete them.
 */
const withStrength = (
  ingredients: readonly WireIngredient[],
  code: WireCodeableConcept,
  strength: Strength
): readonly WireIngredient[] => {
  const strengthened = flow(namingItemAs(code), (ingredient) => ({ ...ingredient, strength }))
  return Arr.matchLeft(ingredients, {
    onEmpty: () => [strengthened(itemlessIngredient)],
    onNonEmpty: (first, rest) => [strengthened(first), ...rest],
  })
}

/**
 * `strength` → `ingredient[0].strength`, when it parses and there is a `code`
 * to name the ingredient by.
 */
const liftStrength = promoteExtension(
  liftStrengthRatio,
  (medication: ContainedMedication, strength) =>
    Option.map(medication.code, (code) => ({
      ...medication,
      ingredient: withStrength(medication.ingredient ?? [], code, strength),
    }))
)

/** Every promotion on one contained Medication. */
const promoteContainedMedication = flow(withContainedCanonicalDin, liftDescription, liftStrength)

/**
 * Promote every `contained` Medication. Any other entry — another resource
 * type, or a Medication that does not decode — is returned exactly as it went
 * in.
 */
const promoteContained = (contained: readonly unknown[]): readonly unknown[] =>
  Arr.map(contained, modifyIfDecodes(ContainedMedication, promoteContainedMedication))

// ---------------------------------------------------------------------------
// Linking medication[x] to the contained Medication
// ---------------------------------------------------------------------------

/** Where a contained Medication can be linked from: its `id`, and the label its `code` offers. */
interface ContainedMedicationLink {
  readonly id: string
  readonly label: Option.Option<string>
}

/** The link to a contained Medication, when it has both an `id` to point at and a `code`. */
const containedMedicationLink = (entry: unknown): Option.Option<ContainedMedicationLink> =>
  pipe(
    decodeContainedMedication(entry),
    Option.flatMap(({ id, code }) => Option.all({ id: Option.filter(id, Str.isNonEmpty), code })),
    Option.map(({ id, code }) => ({ id, label: wireConceptLabel(code) }))
  )

/** Where `medicationReference` points today, when that is outside this resource. */
const externalMedicationTarget = (request: MedicationRequest.Type): Option.Option<string> =>
  pipe(
    decodeReference(request.medicationReference),
    Option.flatMapNullable(({ reference }) => reference),
    Option.filter(Str.isNonEmpty),
    Option.filter((target) => Option.isNone(IdentifierAndReference.fragmentIdOf(target)))
  )

/**
 * Whether `medicationReference` may be pointed at the contained Medication: it
 * points nowhere yet, or at a `#fragment` inside this resource. A reference to
 * anything outside names an external Medication nobody here may retarget.
 */
const medicationReferenceIsRetargetable = (request: MedicationRequest.Type): boolean =>
  Option.isNone(externalMedicationTarget(request))

/**
 * The name the linked reference carries: the name the reference already had,
 * else the inline concept's label, else the contained `code`'s.
 *
 * @remarks
 * The inline `medicationCodeableConcept` gives way to the link, but its name
 * must not: a reader that only renders `medication[x]` still needs something
 * to show.
 */
const linkedMedicationLabel = (
  request: MedicationRequest.Type,
  link: ContainedMedicationLink
): string | null =>
  pipe(
    Option.firstSomeOf([
      pipe(
        decodeReference(request.medicationReference),
        Option.flatMapNullable(({ display }) => display),
        Option.filter(Str.isNonEmpty)
      ),
      Option.flatMap(
        decodeCodeableConcept(request.medicationCodeableConcept),
        CodeableConcept.label
      ),
      link.label,
    ]),
    Option.getOrNull
  )

/**
 * `medicationReference` pointed at the contained Medication, keeping every
 * other field of any reference already there.
 */
const referenceToContained = (
  request: MedicationRequest.Type,
  link: ContainedMedicationLink
): IdentifierAndReference.ReferenceType => ({
  ...Option.getOrElse(
    decodeReference(request.medicationReference),
    () => IdentifierAndReference.emptyReference
  ),
  reference: IdentifierAndReference.fragmentReferenceTo(link.id),
  display: linkedMedicationLabel(request, link),
})

/**
 * Link the orphaned `contained` Medication by `medicationReference: '#id'`.
 *
 * @remarks
 * Nothing points at it as the dialect sends it, so its form, manufacturer,
 * strength and description are unreachable. `medication[x]` is a choice, so the
 * inline `medicationCodeableConcept` gives way to the reference.
 */
const linkContainedMedication = (request: MedicationRequest.Type): MedicationRequest.Type =>
  pipe(
    request,
    Option.liftPredicate(medicationReferenceIsRetargetable),
    Option.flatMap(({ contained }) => Arr.findFirst(contained, containedMedicationLink)),
    Option.map((link) => ({
      ...request,
      medicationReference: referenceToContained(request, link),
      medicationCodeableConcept: null,
    })),
    Option.getOrElse(() => request)
  )

export { linkContainedMedication, promoteContained }
