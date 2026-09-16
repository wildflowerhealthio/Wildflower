import { Option, Schema } from 'effect'

import { Code, CodeableConcept, IdentifierAndReference } from 'fhir-r4/data-types'
import type { Extension, Quantity } from 'fhir-r4/data-types'
import type { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import { nonEmpty } from 'kitchen-sink'

import { CarebookExtension } from './carebook.ts'

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
 * Every promotion is lift-and-drop, and conditional: an extension is removed
 * only once its own value has actually landed somewhere. Consumption is
 * therefore tracked by **array index**, never by url.
 *
 * The full table of what moves, what deliberately does not, why, and the traps
 * behind both rules above is in this package's AGENTS.md under "Extension
 * Promotion".
 */

/** UCUM, the code system FHIR quantities use for units of measure. */
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/** UCUM code and display for a day, the unit Rexall's supply durations are in. */
const UCUM_DAY = { code: 'd', unit: 'day' } as const

/** The namespace FHIR R4 requires on a `Narrative.div`, which is typed `xhtml`. */
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

type MedicationRequestType = typeof MedicationRequest.Schema.Type
type MedicationDispenseType = typeof MedicationDispense.Schema.Type
type QuantityType = typeof Quantity.Schema.Type

const decodeReference = Schema.decodeUnknownOption(
  Schema.typeSchema(IdentifierAndReference.ReferenceSchema)
)
const decodeConcept = Schema.decodeUnknownOption(Schema.typeSchema(CodeableConcept.Schema))

/** The wire-shape fields of a `contained` entry; `contained` is untyped passthrough. */
const decodeRecord = Schema.decodeUnknownOption(
  Schema.Record({ key: Schema.String, value: Schema.Unknown })
)

/**
 * Just the `url` + `valueString` of **one** raw `contained` extension. Decoded
 * per entry rather than per array on purpose: a single malformed entry then
 * disables only itself, instead of silently switching off every promotion on
 * the Medication that carries it.
 */
const decodeStringExtension = Schema.decodeUnknownOption(
  Schema.Struct({
    url: Schema.String,
    valueString: Schema.optional(Schema.NullOr(Schema.String)),
  })
)

/**
 * The display-bearing fields of a `CodeableConcept`, named loosely enough to
 * read both the decoded R4 shape and the raw wire JSON of a `contained` entry
 * (whose `Coding.system` is still a string, not the `URL` the type schema
 * expects).
 */
const decodeDisplayable = Schema.decodeUnknownOption(
  Schema.Struct({
    text: Schema.optional(Schema.NullOr(Schema.String)),
    coding: Schema.optional(
      Schema.Array(Schema.Struct({ display: Schema.optional(Schema.NullOr(Schema.String)) }))
    ),
  })
)

/** A concept's `text`, or `null`. */
const conceptText = (value: unknown): string | null => {
  const concept = decodeDisplayable(value)
  return Option.isSome(concept) ? nonEmpty(concept.value.text) : null
}

/** A concept's best human-readable label: its `text`, else the first coding `display`. */
const conceptDisplay = (value: unknown): string | null => {
  const text = conceptText(value)
  if (text !== null) return text
  const concept = decodeDisplayable(value)
  if (Option.isNone(concept)) return null
  for (const coding of concept.value.coding ?? []) {
    const display = nonEmpty(coding.display)
    if (display !== null) return display
  }
  return null
}

/** The index of the first extension with this url, or `-1`. */
const indexOfExtension = (extensions: readonly Extension.Type[], url: string): number =>
  extensions.findIndex((extension) => extension.url === url)

/** Every extension *entry* whose value was consumed by a promotion, dropped. */
const withoutConsumed = (
  extensions: readonly Extension.Type[],
  consumed: ReadonlySet<number>
): readonly Extension.Type[] =>
  consumed.size === 0 ? extensions : extensions.filter((_, index) => !consumed.has(index))

/**
 * Spell out the unit of a supply quantity Rexall sends bare. The dialect emits
 * `{ value }` with no `unit`/`system`/`code` on both
 * `dispenseRequest.expectedSupplyDuration` and `MedicationDispense.daysSupply`;
 * both are days. Only fills a quantity that carries a value and names no unit
 * of its own — a source that starts sending units is left alone.
 */
const withDayUnit = (quantity: QuantityType | null): QuantityType | null =>
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

/**
 * `"10 mg"` / `"500MG"` → a `Ratio` of 10 mg per 1 unit of product. Returns
 * `null` for anything that is not a leading number followed by a unit word, so
 * an unparseable strength keeps its extension instead of being dropped.
 *
 * @remarks
 * `.` is the only decimal separator accepted. Rexall is an English-Canadian
 * pharmacy, where `"1,000 mg"` is one thousand milligrams written with a
 * thousands separator — reading that comma as a decimal point would silently
 * record a 1000× under-dose. Such a string simply fails to match, which leaves
 * the extension in place with its true value intact.
 */
const parseStrength = (raw: string | null): Record<string, unknown> | null => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z/%.-]*)\s*$/.exec(raw ?? '')
  if (match === null) return null
  const [, amount, unit] = match
  if (amount === undefined || unit === undefined) return null
  const value = Number(amount)
  return Number.isFinite(value) ? { numerator: { value, unit }, denominator: { value: 1 } } : null
}

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
const narrativeIsReplaceable = (fields: Record<string, unknown>, code: unknown): boolean => {
  const text = fields['text']
  if (text === undefined || text === null) return true
  const record = decodeRecord(text)
  if (Option.isNone(record)) return false
  const div = record.value['div']
  if (div === undefined || div === null) return true
  return typeof div === 'string' && div === conceptText(code)
}

/**
 * Merge `strength` into `ingredient[0]`, keeping every other ingredient and
 * every other key of the first one. A compounded prescription carries several
 * ingredients, and replacing the array outright would delete them.
 *
 * R4 requires `ingredient.item[x]`, so a slot created from nothing names the
 * Medication's own `code` as the item — the strength is a strength *of* this
 * drug.
 */
const withStrength = (
  existing: unknown,
  code: unknown,
  strength: Record<string, unknown>
): readonly unknown[] => {
  const ingredients: readonly unknown[] = Array.isArray(existing) ? existing : []
  const decoded = decodeRecord(ingredients[0])
  const first: Record<string, unknown> = Option.isSome(decoded) ? decoded.value : {}
  const item =
    'itemCodeableConcept' in first || 'itemReference' in first ? {} : { itemCodeableConcept: code }
  return [{ ...first, ...item, strength }, ...ingredients.slice(1)]
}

/**
 * Promote the two carebook extensions on a `contained` Medication:
 * `description` → the narrative, `strength` → `ingredient[0].strength`.
 *
 * @remarks
 * `contained` is untyped passthrough on the decoded resource, so this reads and
 * rebuilds raw wire JSON, preserving every key it does not touch.
 */
const promoteContainedMedication = (entry: unknown): unknown => {
  const record = decodeRecord(entry)
  if (Option.isNone(record)) return entry
  const fields = record.value
  if (fields['resourceType'] !== 'Medication') return entry

  const rawExtensions: readonly unknown[] = Array.isArray(fields['extension'])
    ? fields['extension']
    : []
  // `??` and not `!== undefined`: an explicit `"code": null` reaches this raw
  // passthrough JSON unfiltered, and is as unusable as an absent code.
  const code = fields['code'] ?? null

  const consumed = new Set<number>()
  let description: string | null = null
  let strength: Record<string, unknown> | null = null

  rawExtensions.forEach((raw, index) => {
    const parsed = decodeStringExtension(raw)
    if (Option.isNone(parsed)) return
    const extension = parsed.value
    if (extension.url === CarebookExtension.MedicationDescription && description === null) {
      const value = nonEmpty(extension.valueString)
      if (value !== null && narrativeIsReplaceable(fields, code)) {
        description = value
        consumed.add(index)
      }
      return
    }
    if (extension.url === CarebookExtension.MedicationStrength && strength === null) {
      const ratio = code === null ? null : parseStrength(extension.valueString ?? null)
      if (ratio !== null) {
        strength = ratio
        consumed.add(index)
      }
    }
  })

  if (consumed.size === 0) return entry

  const next: Record<string, unknown> = { ...fields }
  next['extension'] = rawExtensions.filter((_, index) => !consumed.has(index))
  if (description !== null) next['text'] = { status: 'generated', div: narrativeDiv(description) }
  if (strength !== null) next['ingredient'] = withStrength(fields['ingredient'], code, strength)
  return next
}

/**
 * The first `contained` Medication that carries a usable `code`, as its `id`
 * plus the best label that code offers — or `null` when there is none.
 */
const containedMedicationLink = (
  contained: readonly unknown[]
): { readonly id: string; readonly display: string | null } | null => {
  for (const entry of contained) {
    const record = decodeRecord(entry)
    if (Option.isNone(record)) continue
    const fields = record.value
    if (fields['resourceType'] !== 'Medication') continue
    const code = fields['code'] ?? null
    if (code === null) continue
    const id = fields['id']
    if (typeof id === 'string' && id.length > 0) return { id, display: conceptDisplay(code) }
  }
  return null
}

/**
 * Promote a carebook `MedicationRequest`: `do-not-perform` → `doNotPerform`,
 * `request-type` → `category`, `medication-processor` →
 * `dispenseRequest.performer`, and the UCUM day unit onto
 * `expectedSupplyDuration`.
 *
 * @remarks
 * Also links the orphaned `contained` Medication by
 * `medicationReference: '#id'`. Nothing points at it today, so its form,
 * manufacturer, strength and description are unreachable. `medication[x]` is a
 * choice, so the inline `medicationCodeableConcept` gives way — but its label
 * does not: whatever name the concept (or the contained `code`) carried is
 * copied onto the reference's `display`, so a reader that only knows how to
 * render `medication[x]` still has a name to show.
 *
 * The link is skipped when `medicationReference` already points somewhere that
 * is not a `#fragment`: that is an external Medication nobody here may retarget.
 */
const promoteMedicationRequest = (request: MedicationRequestType): MedicationRequestType => {
  const consumed = new Set<number>()

  const doNotPerformIndex = indexOfExtension(request.extension, CarebookExtension.DoNotPerform)
  const doNotPerform = request.extension[doNotPerformIndex]?.valueBoolean ?? null
  if (doNotPerform !== null) consumed.add(doNotPerformIndex)

  const requestTypeIndex = indexOfExtension(request.extension, CarebookExtension.RequestType)
  const requestType = decodeConcept(request.extension[requestTypeIndex]?.valueCodeableConcept)
  if (Option.isSome(requestType)) consumed.add(requestTypeIndex)

  const processorIndex = indexOfExtension(
    request.extension,
    CarebookExtension.RequestMedicationProcessor
  )
  const performer = decodeReference(request.extension[processorIndex]?.valueReference)

  const contained = request.contained.map(promoteContainedMedication)
  const link = containedMedicationLink(contained)

  const dispenseRequest =
    request.dispenseRequest === null
      ? null
      : {
          ...request.dispenseRequest,
          expectedSupplyDuration: withDayUnit(request.dispenseRequest.expectedSupplyDuration),
          performer: Option.isSome(performer) ? performer.value : request.dispenseRequest.performer,
        }
  // After `dispenseRequest`, not before: with none there is no `performer` to
  // land in, and consuming anyway would destroy the dispensing pharmacy.
  if (dispenseRequest !== null && Option.isSome(performer)) consumed.add(processorIndex)

  const existingTarget = nonEmpty(request.medicationReference?.reference)
  const retargetable = existingTarget === null || existingTarget.startsWith('#')

  return {
    ...request,
    extension: withoutConsumed(request.extension, consumed),
    contained,
    doNotPerform: doNotPerform ?? request.doNotPerform,
    category: Option.isSome(requestType)
      ? [...request.category, requestType.value]
      : request.category,
    ...(link === null || !retargetable
      ? {}
      : {
          medicationReference: {
            ...(request.medicationReference ?? IdentifierAndReference.emptyReference),
            reference: `#${link.id}`,
            display:
              nonEmpty(request.medicationReference?.display) ??
              conceptDisplay(request.medicationCodeableConcept) ??
              link.display,
          },
          medicationCodeableConcept: null,
        }),
    dispenseRequest,
  }
}

/**
 * Promote a carebook `MedicationDispense`: `medication-processor` → `location`,
 * the UCUM day unit onto `daysSupply`, and the same contained-Medication
 * promotions the request path performs.
 *
 * @remarks
 * `location` rather than `performer` because the reference denotes a
 * `Location`: the request path is `…/pharmacy/Location` and the extension's id
 * is that query's `_id`.
 *
 * The `contained` pass is symmetry with the request path rather than an
 * observed need — see AGENTS.md under "Extension Promotion".
 */
const promoteMedicationDispense = (dispense: MedicationDispenseType): MedicationDispenseType => {
  const consumed = new Set<number>()

  const processorIndex = indexOfExtension(
    dispense.extension,
    CarebookExtension.DispenseMedicationProcessor
  )
  const location = decodeReference(dispense.extension[processorIndex]?.valueReference)
  if (Option.isSome(location)) consumed.add(processorIndex)

  return {
    ...dispense,
    extension: withoutConsumed(dispense.extension, consumed),
    contained: dispense.contained.map(promoteContainedMedication),
    location: Option.isSome(location) ? location.value : dispense.location,
    daysSupply: withDayUnit(dispense.daysSupply),
  }
}

export { promoteMedicationDispense, promoteMedicationRequest }
