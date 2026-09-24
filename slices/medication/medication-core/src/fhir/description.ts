import { Array as Arr, Option, pipe } from 'effect'
import { Extension } from 'fhir-r4/data-types'
import type { Medication as FhirMedication, MedicationRequest } from 'fhir-r4/resources'
import { nonEmpty } from 'kitchen-sink'

import { dosageTextOf } from './free-text.ts'
import { containedMedicationOf } from './medication-slots.ts'

/**
 * The carebook `description` extension on a contained Medication (e.g.
 * `"999 mg - Capsule"`). `rexall-be-well-source` promotes it into the
 * Medication's narrative, but stands down — leaving the extension in place —
 * when the narrative already holds real content, so the reader still looks here
 * first. Kept in step by hand with that package's
 * `CarebookExtension.MedicationDescription`; importing it would make this
 * package depend on a source slice for one string.
 */
const DESCRIPTION_EXTENSION_URL =
  'http://schemas.carebook.com/v1/fhir/medication/extension/description'

const XML_UNESCAPES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
}

/**
 * The text content of a FHIR `Narrative.div`. `div` is typed `xhtml`, so it
 * arrives as markup (`<div xmlns="…">20 mg - Atorvastatin</div>`), not as the
 * string to display: tags are stripped, the five XML entities are unescaped,
 * and whitespace is collapsed.
 *
 * @remarks
 * Deliberately crude. A narrative is free-form and a server may put a whole
 * generated table in one, which this flattens to a run-on line — acceptable
 * because it is only ever a fallback in {@link descriptionOf}.
 */
const narrativeText = (div: string): string =>
  div
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (entity) => XML_UNESCAPES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim()

/** An extension's `valueString`, when it carries a non-blank one. */
const nonEmptyValueStringOf = (extension: Extension.Type): Option.Option<string> =>
  Option.fromNullable(nonEmpty(extension.valueString))

/** The first non-blank carebook `description` extension on a contained Medication. */
const descriptionExtensionOf = (medication: FhirMedication.Type): string | null =>
  pipe(
    medication.extension,
    Arr.filter(Extension.hasUrl(DESCRIPTION_EXTENSION_URL)),
    Arr.findFirst(nonEmptyValueStringOf),
    Option.getOrNull
  )

/** The text content of a contained Medication's narrative, when it has any. */
const narrativeTextOf = (medication: FhirMedication.Type): string | null => {
  const div = nonEmpty(medication.text?.div)
  return div === null ? null : nonEmpty(narrativeText(div))
}

/**
 * A human-readable description of the medication (e.g. `"20 mg - Tablet"`).
 *
 * @returns The first of: the contained Medication's carebook `description`
 *   extension, the text of its narrative, the joined `dosageInstruction` sig;
 *   `null` when none is present.
 *
 * @remarks
 * The extension comes before the narrative because `rexall-be-well-source`
 * only promotes it into the narrative when the narrative is free real estate;
 * when it stands down, the narrative is someone else's content and the
 * extension is the description.
 */
const descriptionOf = (request: MedicationRequest.Type): string | null => {
  const contained = containedMedicationOf(request)
  const containedDescription =
    contained === null ? null : (descriptionExtensionOf(contained) ?? narrativeTextOf(contained))
  return containedDescription ?? dosageTextOf(request)
}

export { descriptionOf }
