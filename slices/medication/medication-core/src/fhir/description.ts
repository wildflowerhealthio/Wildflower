import { Array as Arr, Option, pipe, Schema } from 'effect'
import { Extension, Narrative, WildflowerExtension } from 'fhir-r4/data-types'
import type { Medication as FhirMedication, MedicationRequest } from 'fhir-r4/resources'
import { nonEmpty } from 'kitchen-sink'

import { dosageTextOf } from './free-text.ts'
import { containedMedicationOf } from './medication-slots.ts'

/**
 * The text content of a narrative `div`. `div` is typed `xhtml`, so it arrives
 * as markup (`<div xmlns="…">20 mg - Atorvastatin</div>`), not as the string to
 * display. Crude by design — see `Narrative.TextFromDiv` — which is acceptable
 * because the narrative is only ever a fallback in {@link descriptionOf}.
 */
const narrativeText = Schema.decodeSync(Narrative.TextFromDiv)

/** An extension's `valueString`, when it carries a non-blank one. */
const nonEmptyValueStringOf = (extension: Extension.Type): Option.Option<string> =>
  Option.fromNullable(nonEmpty(extension.valueString))

/**
 * The first non-blank {@link WildflowerExtension.MedicationDescription} on a
 * contained Medication — where a source puts the description when the
 * narrative already holds other content.
 */
const descriptionExtensionOf = (medication: FhirMedication.Type): string | null =>
  pipe(
    medication.extension,
    Arr.filter(Extension.hasUrl(WildflowerExtension.MedicationDescription)),
    Arr.findFirst(nonEmptyValueStringOf),
    Option.getOrNull
  )

/** The text content of a contained Medication's narrative, when it has any. */
const narrativeTextOf = (medication: FhirMedication.Type): string | null =>
  pipe(
    Option.fromNullable(nonEmpty(medication.text?.div)),
    Option.flatMapNullable((div) => nonEmpty(narrativeText(div))),
    Option.getOrNull
  )

/**
 * A human-readable description of the medication (e.g. `"20 mg - Tablet"`).
 *
 * @returns The first of: the contained Medication's Wildflower description
 *   extension, the text of its narrative, the joined `dosageInstruction` sig;
 *   `null` when none is present.
 *
 * @remarks
 * The extension comes before the narrative because a source writes the
 * description there only when the narrative is someone else's content; then
 * the extension is the description, and the narrative is not.
 */
const descriptionOf = (request: MedicationRequest.Type): string | null =>
  pipe(
    Option.fromNullable(containedMedicationOf(request)),
    Option.flatMapNullable(
      (contained) => descriptionExtensionOf(contained) ?? narrativeTextOf(contained)
    ),
    Option.getOrElse(() => dosageTextOf(request))
  )

export { descriptionOf }
