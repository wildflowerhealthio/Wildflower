import { Array as Arr, Option, pipe, Schema } from 'effect'

import { IdentifierAndReference } from 'fhir-r4/data-types'
import type { MedicationRequest } from 'fhir-r4/resources'
import { nonEmpty } from 'kitchen-sink'

import { CarebookExtension } from '../carebook.ts'
import { decodeCodeableConcept, decodeReference } from './decoded-r4.ts'
import { wireConceptWithCanonicalDin } from './din.ts'
import { liftRawExtension } from './lift.ts'
import { StrengthRatioFromString } from './strength-ratio.ts'
import { OptionalWireString, OtherWireFields, WireCodeableConcept } from './wire.ts'

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
// Narrative
// ---------------------------------------------------------------------------

/** The namespace FHIR R4 requires on a `Narrative.div`, which is typed `xhtml`. */
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

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

// ---------------------------------------------------------------------------
// Steps on one contained Medication
// ---------------------------------------------------------------------------

/** Give the contained Medication's vendor DIN coding a canonical twin. */
const withContainedCanonicalDin = (medication: ContainedMedication): ContainedMedication =>
  medication.code === undefined || medication.code === null
    ? medication
    : { ...medication, code: wireConceptWithCanonicalDin(medication.code) }

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

/** Promote one `contained` entry, if it decodes as a {@link ContainedMedication}. */
const promoteContainedEntry = (entry: unknown): unknown =>
  pipe(
    decodeContainedMedication(entry),
    Option.map((medication) =>
      pipe(medication, withContainedCanonicalDin, liftDescription, liftStrength)
    ),
    Option.getOrElse(() => entry)
  )

// ---------------------------------------------------------------------------
// Resource steps
// ---------------------------------------------------------------------------

/**
 * Promote every `contained` Medication: a canonical DIN twin on its `code`,
 * `description` → the narrative, `strength` → `ingredient[0].strength`.
 */
const promoteContained = <R extends { readonly contained: readonly unknown[] }>(
  resource: R
): R => ({
  ...resource,
  contained: resource.contained.map(promoteContainedEntry),
})

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

export { linkContainedMedication, promoteContained }
