import { DateTime, Option, Schema } from 'effect'
import {
  CanadianCodingSystem,
  CodeableConcept,
  IdentifierAndReference,
  WildflowerExtension,
} from 'fhir-r4/data-types'
import { Medication as FhirMedication, type MedicationRequest } from 'fhir-r4/resources'
import { nonEmpty } from 'kitchen-sink'
import { nextFillDate } from 'medication-calendar-core'

import type { Medication } from '../medication.ts'

/** The decoded FHIR R4 `MedicationRequest` resource. */
type MedicationRequestResource = MedicationRequest.Type

/** A decoded FHIR R4 `CodeableConcept`. */
type CodeableConceptValue = Schema.Schema.Type<typeof CodeableConcept.Schema>

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

/**
 * Store-locator bases the sources write onto
 * `dispenseRequest.performer.reference`. A reference under one of them names
 * that chain's store. Keep in step with `rexall-be-well-source`'s
 * `REXALL_STORE_LOCATOR_BASE` and `shoppers-drugmart-source`'s
 * `SHOPPERS_STORE_LOCATOR_BASE`.
 */
const REXALL_STORE_URL_BASE = 'https://www.rexall.ca/storelocator/store/'
const SHOPPERS_STORE_URL_BASE = 'https://www.shoppersdrugmart.ca/store-locator/store/'

// `medication[x]` is typed `any` on the decoded resource (fhir-r4 resolves
// choice datatypes through a registry) and `contained` is untyped passthrough.
// Each is taken as `unknown` and decoded through fhir-r4's own schema: the
// `medication[x]` slots already hold *decoded* values, so they go through the
// type side (`Schema.typeSchema`); `contained` entries are raw wire JSON, so they
// go through the full wire schema.
const decodeConcept = Schema.decodeUnknownOption(Schema.typeSchema(CodeableConcept.Schema))
const decodeReference = Schema.decodeUnknownOption(
  Schema.typeSchema(IdentifierAndReference.ReferenceSchema)
)
const decodeContainedMedication = Schema.decodeUnknownOption(FhirMedication.Schema)

/** `medicationCodeableConcept`, or `null` when the request names its drug another way. */
const medicationConceptOf = (request: MedicationRequestResource): CodeableConceptValue | null => {
  const slot: unknown = request.medicationCodeableConcept
  return Option.getOrNull(decodeConcept(slot))
}

/** `medicationReference`, or `null` when the request names its drug another way. */
const medicationReferenceOf = (
  request: MedicationRequestResource
): IdentifierAndReference.ReferenceType | null => {
  const slot: unknown = request.medicationReference
  return Option.getOrNull(decodeReference(slot))
}

/**
 * The Medication carried inline in `MedicationRequest.contained`.
 *
 * @returns The contained Medication a `#id` `medicationReference` points at, or
 *   the first contained Medication when the reference is absent or external;
 *   `null` when none decodes.
 *
 * @remarks
 * An entry that does not decode as an R4 `Medication` is skipped, not fatal.
 */
const containedMedicationOf = (request: MedicationRequestResource): FhirMedication.Type | null => {
  const ref = nonEmpty(medicationReferenceOf(request)?.reference)
  const medications = request.contained.flatMap((entry: unknown) => {
    const decoded = decodeContainedMedication(entry)
    return Option.isSome(decoded) ? [decoded.value] : []
  })
  const byId = ref === null ? undefined : medications.find((med) => `#${med.id ?? ''}` === ref)
  return byId ?? medications[0] ?? null
}

/** The first non-empty `code` under {@link CanadianCodingSystem.Din} in a concept. */
const canonicalDinIn = (concept: CodeableConceptValue | null): string | null => {
  for (const coding of concept?.coding ?? []) {
    if (coding.system?.href !== CanadianCodingSystem.Din) continue
    const code = nonEmpty(coding.code)
    if (code !== null) return code
  }
  return null
}

/**
 * The Drug Identification Number: the {@link CanadianCodingSystem.Din} coding
 * on the contained Medication's `code`, else on `medicationCodeableConcept`.
 *
 * @remarks
 * Only the canonical system is read. A source keeps any vendor DIN coding
 * beside it, and a drug vocabulary that is not a DIN (RxNorm, SNOMED CT) must
 * never print as one.
 */
const dinOf = (request: MedicationRequestResource): string | null =>
  canonicalDinIn(containedMedicationOf(request)?.code ?? null) ??
  canonicalDinIn(medicationConceptOf(request))

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

/**
 * Newline-join the non-empty `text` of every entry; `null` when none carry text.
 * Shared by the `note` and `dosageInstruction` accessors.
 */
const joinTexts = (entries: readonly { readonly text: string | null }[]): string | null => {
  const texts = entries.flatMap((entry) => {
    const text = nonEmpty(entry.text)
    return text === null ? [] : [text]
  })
  return texts.length > 0 ? texts.join('\n') : null
}

/**
 * The free-text dosage sig, newline-joining every `dosageInstruction.text`
 * (e.g. Shoppers Drug Mart's per-prescription "direction"); `null` when none
 * carry text.
 */
const dosageTextOf = (request: MedicationRequestResource): string | null =>
  joinTexts(request.dosageInstruction)

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
const descriptionOf = (request: MedicationRequestResource): string | null => {
  const contained = containedMedicationOf(request)
  if (contained !== null) {
    for (const extension of contained.extension) {
      if (extension.url !== DESCRIPTION_EXTENSION_URL) continue
      const value = nonEmpty(extension.valueString)
      if (value !== null) return value
    }
    const div = nonEmpty(contained.text?.div)
    const narrative = div === null ? null : nonEmpty(narrativeText(div))
    if (narrative !== null) return narrative
  }
  return dosageTextOf(request)
}

/** A concept's `text`, else its first coding `display`; `null` when neither is present. */
const conceptName = (concept: CodeableConceptValue | null): string | null => {
  if (concept === null) return null
  const text = nonEmpty(concept.text)
  if (text !== null) return text
  for (const coding of concept.coding) {
    const display = nonEmpty(coding.display)
    if (display !== null) return display
  }
  return null
}

/**
 * Best human-readable name for the medication: the `medicationCodeableConcept`
 * text or first coding display, then the `medicationReference` display, then
 * the contained Medication's `code`. Falls back to `"Unknown medication"` so a
 * row always renders.
 */
const displayNameOf = (request: MedicationRequestResource): string =>
  conceptName(medicationConceptOf(request)) ??
  nonEmpty(medicationReferenceOf(request)?.display) ??
  conceptName(containedMedicationOf(request)?.code ?? null) ??
  'Unknown medication'

/** The prescriber's display name, from `MedicationRequest.requester`. */
const requesterOf = (request: MedicationRequestResource): string | null =>
  nonEmpty(request.requester?.display)

/** All `MedicationRequest.note` texts, newline-joined; `null` when there are none. */
const noteOf = (request: MedicationRequestResource): string | null => joinTexts(request.note)

/** `dispenseRequest.numberOfRepeatsAllowed` — the total repeats authorized. */
const repeatsAllowedOf = (request: MedicationRequestResource): number | null =>
  request.dispenseRequest?.numberOfRepeatsAllowed ?? null

/**
 * The repeats still available: the {@link WildflowerExtension.RepeatsAvailable}
 * `valueInteger` on `dispenseRequest.extension`. R4 has no standard slot for
 * it, only the total {@link repeatsAllowedOf}.
 */
const repeatsAvailableOf = (request: MedicationRequestResource): number | null => {
  for (const extension of request.dispenseRequest?.extension ?? []) {
    if (extension.url === WildflowerExtension.RepeatsAvailable && extension.valueInteger !== null) {
      return extension.valueInteger
    }
  }
  return null
}

/**
 * `dispenseRequest.performer.reference` when it is a URL under `base` — the
 * slot the sources write the dispensing store's public store-locator page to.
 */
const storeUrlOf = (request: MedicationRequestResource, base: string): string | null => {
  const reference = nonEmpty(request.dispenseRequest?.performer?.reference)
  return reference !== null && reference.startsWith(base) ? reference : null
}

/** The Rexall store-locator URL the request was dispensed from, if any. */
const rexallStoreUrlOf = (request: MedicationRequestResource): string | null =>
  storeUrlOf(request, REXALL_STORE_URL_BASE)

/** The Shoppers Drug Mart store-locator URL the request was dispensed from, if any. */
const shoppersStoreUrlOf = (request: MedicationRequestResource): string | null =>
  storeUrlOf(request, SHOPPERS_STORE_URL_BASE)

/**
 * Estimated next-fill date as an ISO instant: `authoredOn` advanced by
 * `dispenseRequest.expectedSupplyDuration` (when the current supply runs out).
 * `null` unless both are present. The date math is `medication-calendar-core`'s
 * `nextFillDate`.
 *
 * @remarks
 * `dispenseRequest.validityPeriod.end` is the *authorization* expiry in R4, not
 * a fill date, so it is deliberately not a fallback.
 */
const nextFillDateOf = (request: MedicationRequestResource): string | null => {
  const authored = request.authoredOn
  const supply = request.dispenseRequest?.expectedSupplyDuration
  if (authored === null || supply === null || supply === undefined) return null
  return nextFillDate(DateTime.formatIso(authored), supply)
}

/**
 * Map a decoded FHIR `MedicationRequest` onto this package's
 * {@link Medication} value the matchers consume. `fallbackId`
 * supplies a stable React key when the resource carries no `id`.
 */
const medicationRequestToMedication = (
  request: MedicationRequestResource,
  fallbackId: string
): Medication => ({
  id: nonEmpty(request.id) ?? fallbackId,
  displayName: displayNameOf(request),
  status: request.status,
  authoredOn: request.authoredOn === null ? undefined : DateTime.formatIso(request.authoredOn),
})

/**
 * The display-oriented view of a `MedicationRequest`: the core {@link Medication}
 * (used for sponsorship and interaction matching) plus the extra fields the
 * medication card renders, each read by the accessor of the same name. Any
 * field the resource does not carry is `null`.
 */
interface MedicationView {
  readonly medication: Medication
  /** Drug Identification Number — see {@link dinOf}. */
  readonly din: string | null
  /** Human-readable description or sig — see {@link descriptionOf}. */
  readonly description: string | null
  /** Prescriber display name (`requester.display`). */
  readonly requester: string | null
  /** Newline-joined `note.text` values. */
  readonly note: string | null
  /** `dispenseRequest.numberOfRepeatsAllowed`. */
  readonly repeatsAllowed: number | null
  /** Remaining repeats — see {@link repeatsAvailableOf}. */
  readonly repeatsAvailable: number | null
  /** Estimated next-fill date (ISO) — see {@link nextFillDateOf}. */
  readonly nextFillDate: string | null
  /** Rexall store-locator URL when the request is sourced from a Rexall store. */
  readonly rexallStoreUrl: string | null
  /** Shoppers Drug Mart store-locator URL when the request is sourced from a Shoppers store. */
  readonly shoppersStoreUrl: string | null
}

/**
 * Whether a medication still has a refill to pick up: repeats are allowed and at
 * least one remains. With a refill left the supply-runout date is the next fill;
 * with none, that date is simply when the supply is exhausted.
 */
const hasRefill = (view: MedicationView): boolean =>
  view.repeatsAllowed !== null && view.repeatsAllowed > 0 && (view.repeatsAvailable ?? 0) > 0

/** Build the rich {@link MedicationView} for one request. */
const medicationRequestToMedicationView = (
  request: MedicationRequestResource,
  fallbackId: string
): MedicationView => ({
  medication: medicationRequestToMedication(request, fallbackId),
  din: dinOf(request),
  description: descriptionOf(request),
  requester: requesterOf(request),
  note: noteOf(request),
  repeatsAllowed: repeatsAllowedOf(request),
  repeatsAvailable: repeatsAvailableOf(request),
  nextFillDate: nextFillDateOf(request),
  rexallStoreUrl: rexallStoreUrlOf(request),
  shoppersStoreUrl: shoppersStoreUrlOf(request),
})

/** Map a bundle's worth of requests, deriving fallback keys from position. */
const medicationRequestsToMedications = (
  requests: readonly MedicationRequestResource[]
): readonly Medication[] =>
  requests.map((request, index) =>
    medicationRequestToMedication(request, `medication-request-${index}`)
  )

/** Map a bundle's worth of requests to rich {@link MedicationView}s. */
const medicationRequestsToMedicationViews = (
  requests: readonly MedicationRequestResource[]
): readonly MedicationView[] =>
  requests.map((request, index) =>
    medicationRequestToMedicationView(request, `medication-request-${index}`)
  )

export {
  containedMedicationOf,
  descriptionOf,
  dinOf,
  displayNameOf,
  dosageTextOf,
  hasRefill,
  medicationConceptOf,
  medicationReferenceOf,
  medicationRequestToMedication,
  medicationRequestsToMedications,
  medicationRequestToMedicationView,
  medicationRequestsToMedicationViews,
  nextFillDateOf,
  noteOf,
  repeatsAllowedOf,
  repeatsAvailableOf,
  requesterOf,
  rexallStoreUrlOf,
  shoppersStoreUrlOf,
  type MedicationRequestResource,
  type MedicationView,
}
