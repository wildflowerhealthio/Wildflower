import { DateTime, Option, Schema } from 'effect'
import type { MedicationRequest } from 'fhir-r4/resources'
import { nonEmpty } from 'kitchen-sink'
import type { Medication } from 'medication-sponsorship-core'

/** The decoded FHIR R4 `MedicationRequest` resource. */
type MedicationRequestResource = Schema.Schema.Type<typeof MedicationRequest.Schema>

// carebook dialect constants for the Medications app's FHIR server. Keep them
// verbatim. The DIN lives as a `code.coding` entry on the (contained)
// Medication; the human-readable description and the remaining-repeats count
// are `extension`s.
//
// These are *the same* dialect `rexall-be-well-collector` decodes, not a
// distinct one — a real capture of the Rexall tunnel emits these exact URLs,
// including the `v2` spelling of the repeats extension below. That package
// exports the catalogue as `Carebook.*`, but importing it would make this UI
// slice depend on a collector slice for six string constants, so the two are
// kept in step by hand. Change one side and check the other.
const DIN_CODING_SYSTEM = 'http://schema.carebook.com/v1/fhir/coding/medication-din-code'
const DESCRIPTION_EXTENSION_URL =
  'http://schemas.carebook.com/v1/fhir/medication/extension/description'
const REPEATS_AVAILABLE_EXTENSION_URL =
  'http://schemas.carebook.com/v2/fhir/medicationrequest/extension/number-of-repeats-available'
// A request sourced from a Rexall pharmacy carries both of these top-level
// extensions; together they build a store-locator link. `external-system-source`
// must read `RexallPharmacy` and `external-store-id` supplies the store number.
const EXTERNAL_SYSTEM_SOURCE_URL =
  'http://schemas.carebook.com/v1/fhir/common/extension/external-system-source'
const EXTERNAL_STORE_ID_URL =
  'http://schemas.carebook.com/v1/fhir/medicationrequest/extension/external-store-id'
const REXALL_SYSTEM_SOURCE = 'RexallPharmacy'
const REXALL_STORE_URL_BASE = 'https://www.rexall.ca/storelocator/store/'

// Several fields we read — the `medication[x]` choice slots, `contained`,
// `requester`, `note`, `dispenseRequest`, and the passthrough `value[x]` on an
// extension — are typed loosely (often `any`) on the decoded resource. Rather
// than read `any`, we take each as `unknown` and decode it through a permissive
// local schema naming only the fields we display: type-safe, and tolerant of
// both the wire and decoded shapes. Effect's `Struct` ignores excess keys on
// decode, so these narrow schemas happily read a much larger object.
const nullableString = Schema.optional(Schema.NullOr(Schema.String))
const nullableNumber = Schema.optional(Schema.NullOr(Schema.Number))

const Coding = Schema.Struct({
  system: nullableString,
  code: nullableString,
  display: nullableString,
})
const MedicationConcept = Schema.Struct({
  text: nullableString,
  coding: Schema.optional(Schema.Array(Coding)),
})
const MedicationReference = Schema.Struct({
  display: nullableString,
  reference: nullableString,
})

/** A Medication carried inline in `MedicationRequest.contained` (carebook `#id`). */
const ContainedMedication = Schema.Struct({
  id: nullableString,
  resourceType: nullableString,
  code: Schema.optional(Schema.NullOr(MedicationConcept)),
  text: Schema.optional(Schema.NullOr(Schema.Struct({ div: nullableString }))),
  extension: Schema.optional(
    Schema.Array(Schema.Struct({ url: nullableString, valueString: nullableString }))
  ),
})
type ContainedMedicationValue = Schema.Schema.Type<typeof ContainedMedication>

const Requester = Schema.Struct({ display: nullableString })
const Notes = Schema.Array(Schema.Struct({ text: nullableString }))
/** FHIR `Duration` (a Quantity): a numeric `value` with a UCUM `code`/`unit`. */
const SupplyDuration = Schema.Struct({
  value: nullableNumber,
  unit: nullableString,
  code: nullableString,
})
type SupplyDuration = Schema.Schema.Type<typeof SupplyDuration>
const DispenseRequest = Schema.Struct({
  numberOfRepeatsAllowed: nullableNumber,
  expectedSupplyDuration: Schema.optional(Schema.NullOr(SupplyDuration)),
  modifierExtension: Schema.optional(
    Schema.Array(Schema.Struct({ url: nullableString, valueDecimal: nullableNumber }))
  ),
})

/** Top-level `MedicationRequest.extension` entries carrying a `valueString`. */
const StringExtensions = Schema.Array(
  Schema.Struct({ url: nullableString, valueString: nullableString })
)

const decodeConcept = Schema.decodeUnknownOption(MedicationConcept)
const decodeReference = Schema.decodeUnknownOption(MedicationReference)
const decodeContainedMedication = Schema.decodeUnknownOption(ContainedMedication)
const decodeRequester = Schema.decodeUnknownOption(Requester)
const decodeNotes = Schema.decodeUnknownOption(Notes)
const decodeDispenseRequest = Schema.decodeUnknownOption(DispenseRequest)
const decodeStringExtensions = Schema.decodeUnknownOption(StringExtensions)

/**
 * The Medication resource carebook inlines in `MedicationRequest.contained`,
 * pointed at by a `#id` `medicationReference`. Returns the entry matching that
 * fragment id, or the first contained Medication when the reference is absent
 * or external — the DIN coding and description extension are read from it.
 */
const containedMedicationOf = (
  request: MedicationRequestResource
): ContainedMedicationValue | undefined => {
  const referenceSlot: unknown = request.medicationReference
  const reference = decodeReference(referenceSlot)
  const ref = Option.isSome(reference) ? nonEmpty(reference.value.reference) : null

  const containedSlot: unknown = request.contained
  const contained: readonly unknown[] = Array.isArray(containedSlot) ? containedSlot : []
  const medications = contained.flatMap((entry) => {
    const decoded = decodeContainedMedication(entry)
    return Option.isSome(decoded) && decoded.value.resourceType === 'Medication'
      ? [decoded.value]
      : []
  })

  const byId = ref === null ? undefined : medications.find((med) => `#${med.id ?? ''}` === ref)
  return byId ?? medications[0]
}

/** The DIN carried on the Medication's `code.coding` under the carebook system. */
const dinOf = (medication: ContainedMedicationValue): string | null => {
  for (const coding of medication.code?.coding ?? []) {
    if (coding.system === DIN_CODING_SYSTEM) {
      const code = nonEmpty(coding.code)
      if (code !== null) return code
    }
  }
  return null
}

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
 * because it is only ever the *fallback* in {@link descriptionOf}, reached when
 * the carebook description extension is gone precisely because a promotion put
 * that description in the narrative.
 */
const narrativeText = (div: string): string =>
  div
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (entity) => XML_UNESCAPES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim()

/**
 * The carebook description (e.g. `"999 mg - Capsule"`).
 *
 * Read from the `description` extension first, falling back to the Medication's
 * narrative. `rexall-be-well-collector` promotes that extension into `text.div`
 * and drops it, so a resource it wrote carries exactly one of the two.
 *
 * The order matters for a resource that has *not* been promoted — a row already
 * in the store, or one from the Medications app's own FHIR server — because it
 * carries **both**: the extension, and the dialect's own narrative, which is a
 * byte-copy of `code.text`, i.e. the drug name the card already shows as its
 * title.
 */
const descriptionOf = (medication: ContainedMedicationValue): string | null => {
  for (const extension of medication.extension ?? []) {
    if (extension.url === DESCRIPTION_EXTENSION_URL) {
      const value = nonEmpty(extension.valueString)
      if (value !== null) return value
    }
  }
  const narrative = nonEmpty(medication.text?.div)
  return narrative === null ? null : nonEmpty(narrativeText(narrative))
}

/**
 * Best human-readable name for the medication, preferring the inline
 * `medicationCodeableConcept` text, then its first coding display, then a
 * referenced medication's display, then the contained Medication's own
 * `code`. Falls back to a generic label so a row always renders.
 */
const displayNameOf = (request: MedicationRequestResource): string => {
  const conceptSlot: unknown = request.medicationCodeableConcept
  const concept = decodeConcept(conceptSlot)
  if (Option.isSome(concept)) {
    const text = nonEmpty(concept.value.text)
    if (text !== null) return text
    for (const coding of concept.value.coding ?? []) {
      const display = nonEmpty(coding.display)
      if (display !== null) return display
    }
  }
  const referenceSlot: unknown = request.medicationReference
  const reference = decodeReference(referenceSlot)
  if (Option.isSome(reference)) {
    const display = nonEmpty(reference.value.display)
    if (display !== null) return display
  }
  const contained = containedMedicationOf(request)
  if (contained !== undefined) {
    const text = nonEmpty(contained.code?.text)
    if (text !== null) return text
    for (const coding of contained.code?.coding ?? []) {
      const display = nonEmpty(coding.display)
      if (display !== null) return display
    }
  }
  return 'Unknown medication'
}

/** The prescriber's display name, from `MedicationRequest.requester`. */
const requesterOf = (request: MedicationRequestResource): string | null => {
  const requester = decodeRequester(request.requester)
  return Option.isSome(requester) ? nonEmpty(requester.value.display) : null
}

/** All `MedicationRequest.note` texts, newline-joined; `null` when there are none. */
const noteOf = (request: MedicationRequestResource): string | null => {
  const notes = decodeNotes(request.note)
  if (Option.isNone(notes)) return null
  const texts = notes.value.flatMap((note) => {
    const text = nonEmpty(note.text)
    return text === null ? [] : [text]
  })
  return texts.length > 0 ? texts.join('\n') : null
}

/**
 * The Rexall store-locator URL for a request that carries both the
 * `external-system-source` (`RexallPharmacy`) and `external-store-id` top-level
 * extensions; `null` unless both are present.
 */
const rexallStoreUrlOf = (request: MedicationRequestResource): string | null => {
  const extensions = decodeStringExtensions(request.extension)
  if (Option.isNone(extensions)) return null
  let isRexall = false
  let storeId: string | null = null
  for (const extension of extensions.value) {
    if (
      extension.url === EXTERNAL_SYSTEM_SOURCE_URL &&
      extension.valueString === REXALL_SYSTEM_SOURCE
    ) {
      isRexall = true
    } else if (extension.url === EXTERNAL_STORE_ID_URL) {
      storeId = nonEmpty(extension.valueString) ?? storeId
    }
  }
  return isRexall && storeId !== null
    ? `${REXALL_STORE_URL_BASE}${encodeURIComponent(storeId)}`
    : null
}

/**
 * The dispense-repeat counts: `numberOfRepeatsAllowed` (standard R4) and the
 * carebook remaining-repeats `modifierExtension` (`valueDecimal`).
 */
const repeatsOf = (
  request: MedicationRequestResource
): { readonly allowed: number | null; readonly available: number | null } => {
  const dispenseRequest = decodeDispenseRequest(request.dispenseRequest)
  if (Option.isNone(dispenseRequest)) return { allowed: null, available: null }
  const allowed = dispenseRequest.value.numberOfRepeatsAllowed ?? null
  let available: number | null = null
  for (const extension of dispenseRequest.value.modifierExtension ?? []) {
    if (
      extension.url === REPEATS_AVAILABLE_EXTENSION_URL &&
      extension.valueDecimal !== null &&
      extension.valueDecimal !== undefined
    ) {
      available = extension.valueDecimal
      break
    }
  }
  return { allowed, available }
}

// UCUM time codes and their spelled-out `unit` fallbacks → a builder for the
// matching `DateTime.add` part. Supply durations are almost always days, but
// weeks/months are valid; an unrecognized or absent unit falls back to days
// (see `supplyToParts`). `Partial` keeps index access `Builder | undefined`.
type PartBuilder = (amount: number) => Partial<DateTime.DateTime.PartsForMath>
const UCUM_UNIT: Partial<Record<string, PartBuilder>> = {
  s: (n) => ({ seconds: n }),
  min: (n) => ({ minutes: n }),
  h: (n) => ({ hours: n }),
  d: (n) => ({ days: n }),
  wk: (n) => ({ weeks: n }),
  mo: (n) => ({ months: n }),
  a: (n) => ({ years: n }),
}
const SPELLED_UNIT: Partial<Record<string, PartBuilder>> = {
  second: UCUM_UNIT.s,
  seconds: UCUM_UNIT.s,
  minute: UCUM_UNIT.min,
  minutes: UCUM_UNIT.min,
  hour: UCUM_UNIT.h,
  hours: UCUM_UNIT.h,
  day: UCUM_UNIT.d,
  days: UCUM_UNIT.d,
  week: UCUM_UNIT.wk,
  weeks: UCUM_UNIT.wk,
  month: UCUM_UNIT.mo,
  months: UCUM_UNIT.mo,
  year: UCUM_UNIT.a,
  years: UCUM_UNIT.a,
}

/** The `expectedSupplyDuration` as `DateTime.add` parts, or `null` if unusable. */
const supplyToParts = (supply: SupplyDuration): Partial<DateTime.DateTime.PartsForMath> | null => {
  const { value } = supply
  if (value === null || value === undefined || value <= 0) return null
  const fromCode =
    supply.code === null || supply.code === undefined ? undefined : UCUM_UNIT[supply.code]
  const fromUnit =
    supply.unit === null || supply.unit === undefined
      ? undefined
      : SPELLED_UNIT[supply.unit.toLowerCase()]
  const build = fromCode ?? fromUnit ?? UCUM_UNIT.d
  return build === undefined ? null : build(Math.round(value))
}

/**
 * Estimated next-fill date as an ISO instant: `authoredOn` advanced by the
 * `dispenseRequest.expectedSupplyDuration` (i.e. when the current supply runs
 * out). `null` unless both the authored date and a usable supply duration are
 * present.
 */
const nextFillDateOf = (request: MedicationRequestResource): string | null => {
  const authored = request.authoredOn
  if (authored === null || authored === undefined) return null
  const dispenseRequest = decodeDispenseRequest(request.dispenseRequest)
  if (Option.isNone(dispenseRequest)) return null
  const supply = dispenseRequest.value.expectedSupplyDuration
  if (supply === null || supply === undefined) return null
  const parts = supplyToParts(supply)
  if (parts === null) return null
  return DateTime.formatIso(DateTime.add(authored, parts))
}

/**
 * A coarse, human-readable distance from `nowMillis` (epoch ms) to an ISO
 * instant, for a next-fill hint: `"today"`, `"in 3 days"`, `"in 2 weeks"`,
 * `"in 5 months"` (and the past `"… ago"` forms). Rounds to whole days, then
 * collapses to weeks past ~10 days and months past ~8 weeks — deliberately
 * imprecise, matching how a fill reminder reads.
 */
// Round a whole-day magnitude to a coarse (count, unit): days up to ~10, then
// weeks up to ~8 weeks, then months.
const coarsen = (days: number): readonly [number, string] => {
  if (days <= 10) return [days, 'day']
  if (days <= 56) return [Math.floor(days / 7), 'week']
  return [Math.floor(days / 30), 'month']
}

const describeDayFromNow = (iso: string, nowMillis: number): string => {
  const target = DateTime.toEpochMillis(DateTime.unsafeMake(iso))
  const days = Math.round((target - nowMillis) / 86_400_000)
  if (days === 0) return 'today'
  const [count, unit] = coarsen(Math.abs(days))
  const phrase = `${count} ${count === 1 ? unit : `${unit}s`}`
  return days > 0 ? `in ${phrase}` : `${phrase} ago`
}

/**
 * Map a decoded FHIR `MedicationRequest` onto the `medication-sponsorship-core`
 * {@link Medication} value the matcher and grouping consume. `fallbackId`
 * supplies a stable React key when the resource carries no `id`.
 */
const medicationRequestToMedication = (
  request: MedicationRequestResource,
  fallbackId: string
): Medication => ({
  id: nonEmpty(request.id) ?? fallbackId,
  displayName: displayNameOf(request),
  status: request.status,
  authoredOn:
    request.authoredOn === null || request.authoredOn === undefined
      ? undefined
      : DateTime.formatIso(request.authoredOn),
})

/**
 * The display-oriented view of a `MedicationRequest`: the core {@link Medication}
 * (used for sponsorship matching) plus the extra carebook fields the medication
 * card renders. Any field the resource does not carry is `null`.
 */
interface MedicationView {
  readonly medication: Medication
  /** Drug Identification Number, from the contained Medication's DIN coding. */
  readonly din: string | null
  /** carebook human-readable description (e.g. `"999 mg - Capsule"`). */
  readonly description: string | null
  /** Prescriber display name (`requester.display`). */
  readonly requester: string | null
  /** Newline-joined `note.text` values. */
  readonly note: string | null
  /** `dispenseRequest.numberOfRepeatsAllowed`. */
  readonly repeatsAllowed: number | null
  /** carebook remaining-repeats `modifierExtension` (`valueDecimal`). */
  readonly repeatsAvailable: number | null
  /** Estimated next-fill date (ISO) — `authoredOn` + `expectedSupplyDuration`. */
  readonly nextFillDate: string | null
  /** Rexall store-locator URL when the request is sourced from a Rexall store. */
  readonly rexallStoreUrl: string | null
}

/** Build the rich {@link MedicationView} for one request. */
const medicationRequestToMedicationView = (
  request: MedicationRequestResource,
  fallbackId: string
): MedicationView => {
  const contained = containedMedicationOf(request)
  const repeats = repeatsOf(request)
  return {
    medication: medicationRequestToMedication(request, fallbackId),
    din: contained === undefined ? null : dinOf(contained),
    description: contained === undefined ? null : descriptionOf(contained),
    requester: requesterOf(request),
    note: noteOf(request),
    repeatsAllowed: repeats.allowed,
    repeatsAvailable: repeats.available,
    nextFillDate: nextFillDateOf(request),
    rexallStoreUrl: rexallStoreUrlOf(request),
  }
}

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
  describeDayFromNow,
  medicationRequestToMedication,
  medicationRequestsToMedications,
  medicationRequestToMedicationView,
  medicationRequestsToMedicationViews,
  type MedicationRequestResource,
  type MedicationView,
}
