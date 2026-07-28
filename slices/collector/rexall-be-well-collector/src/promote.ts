import { Option, Schema } from 'effect'

import { Code, CodeableConcept, IdentifierAndReference } from 'fhir-r4/data-types'
import type { Extension, Quantity } from 'fhir-r4/data-types'
import type { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'

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
 * Every promotion is lift-and-drop, and conditional: the extension is removed
 * only once its value has actually landed.
 *
 * The full table of what moves, what deliberately does not, and why, is in this
 * package's AGENTS.md under "Extension Promotion".
 */

/** UCUM, the code system FHIR quantities use for units of measure. */
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/** UCUM code and display for a day, the unit Rexall's supply durations are in. */
const UCUM_DAY = { code: 'd', unit: 'day' } as const

type RequestType = typeof MedicationRequest.Schema.Type
type DispenseType = typeof MedicationDispense.Schema.Type
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
 * Just the `url` + `valueString` of each raw `contained` extension. Effect
 * structs ignore excess keys, so entries carrying another `value[x]` decode
 * fine and simply surface no `valueString`.
 */
const decodeStringExtensions = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      url: Schema.String,
      valueString: Schema.optional(Schema.NullOr(Schema.String)),
    })
  )
)

const nonEmpty = (value: string | null | undefined): string | null =>
  value !== null && value !== undefined && value.length > 0 ? value : null

/** The extension with this url, or `undefined`. */
const extensionAt = (
  extensions: readonly Extension.Type[],
  url: string
): Extension.Type | undefined => extensions.find((extension) => extension.url === url)

/** Every extension whose url was consumed by a promotion, dropped. */
const withoutConsumed = (
  extensions: readonly Extension.Type[],
  consumed: ReadonlySet<string>
): readonly Extension.Type[] =>
  consumed.size === 0 ? extensions : extensions.filter((e) => !consumed.has(e.url))

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

/**
 * `"10 mg"` / `"500MG"` → a `Ratio` of 10 mg per 1 unit of product. Returns
 * `null` for anything that is not a leading number followed by a unit word, so
 * an unparseable strength keeps its extension instead of being dropped.
 */
const parseStrength = (raw: string | null): Record<string, unknown> | null => {
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*([A-Za-z][A-Za-z/%.-]*)\s*$/.exec(raw ?? '')
  if (match === null) return null
  const [, amount, unit] = match
  if (amount === undefined || unit === undefined) return null
  const value = Number(amount.replace(',', '.'))
  return Number.isFinite(value) ? { numerator: { value, unit }, denominator: { value: 1 } } : null
}

/**
 * Promote the two carebook extensions on a `contained` Medication:
 * `description` → the narrative, `strength` → `ingredient[0].strength`.
 *
 * @remarks
 * The narrative is free real estate — the dialect writes a byte-copy of
 * `code.text` there, and the description is strictly richer. The strength is
 * keyed to the Medication's own `code` as the ingredient item, since R4
 * requires `ingredient.item[x]`.
 *
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
  const parsed = decodeStringExtensions(rawExtensions)
  if (Option.isNone(parsed)) return entry

  const consumed = new Set<number>()
  let description: string | null = null
  let strength: Record<string, unknown> | null = null

  parsed.value.forEach((extension, index) => {
    if (extension.url === CarebookExtension.MedicationDescription && description === null) {
      const value = nonEmpty(extension.valueString)
      if (value !== null) {
        description = value
        consumed.add(index)
      }
      return
    }
    if (extension.url === CarebookExtension.MedicationStrength && strength === null) {
      const ratio =
        fields['code'] === undefined ? null : parseStrength(extension.valueString ?? null)
      if (ratio !== null) {
        strength = ratio
        consumed.add(index)
      }
    }
  })

  if (consumed.size === 0) return entry

  const next: Record<string, unknown> = { ...fields }
  next['extension'] = rawExtensions.filter((_, index) => !consumed.has(index))
  if (description !== null) next['text'] = { status: 'generated', div: description }
  if (strength !== null) {
    next['ingredient'] = [{ itemCodeableConcept: fields['code'], strength }]
  }
  return next
}

/** The `id` of the first `contained` Medication that also carries a `code`, or `null`. */
const containedMedicationId = (contained: readonly unknown[]): string | null => {
  for (const entry of contained) {
    const record = decodeRecord(entry)
    if (Option.isNone(record)) continue
    const fields = record.value
    if (fields['resourceType'] !== 'Medication' || fields['code'] === undefined) continue
    const id = fields['id']
    if (typeof id === 'string' && id.length > 0) return id
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
 * Also links the orphaned `contained` Medication by `medicationReference:
 * '#id'`. Nothing points at it today, so its form, manufacturer, strength and
 * description are unreachable. `medication[x]` is a choice, so the inline
 * `medicationCodeableConcept` gives way — safe because the contained `code` is
 * byte-identical to it, and only done when that code is present.
 */
const promoteMedicationRequest = (request: RequestType): RequestType => {
  const consumed = new Set<string>()

  const doNotPerformExtension = extensionAt(request.extension, CarebookExtension.DoNotPerform)
  const doNotPerform = doNotPerformExtension?.valueBoolean ?? null
  if (doNotPerform !== null) consumed.add(CarebookExtension.DoNotPerform)

  const requestTypeExtension = extensionAt(request.extension, CarebookExtension.RequestType)
  const requestType = decodeConcept(requestTypeExtension?.valueCodeableConcept)
  if (Option.isSome(requestType)) consumed.add(CarebookExtension.RequestType)

  const processorExtension = extensionAt(
    request.extension,
    CarebookExtension.RequestMedicationProcessor
  )
  const performer = decodeReference(processorExtension?.valueReference)
  if (Option.isSome(performer)) consumed.add(CarebookExtension.RequestMedicationProcessor)

  const contained = request.contained.map(promoteContainedMedication)
  const medicationId = containedMedicationId(contained)

  const dispenseRequest =
    request.dispenseRequest === null
      ? null
      : {
          ...request.dispenseRequest,
          expectedSupplyDuration: withDayUnit(request.dispenseRequest.expectedSupplyDuration),
          performer: Option.isSome(performer) ? performer.value : request.dispenseRequest.performer,
        }

  return {
    ...request,
    extension: withoutConsumed(request.extension, consumed),
    contained,
    doNotPerform: doNotPerform ?? request.doNotPerform,
    category: Option.isSome(requestType)
      ? [...request.category, requestType.value]
      : request.category,
    ...(medicationId === null
      ? {}
      : {
          medicationReference: {
            ...IdentifierAndReference.emptyReference,
            reference: `#${medicationId}`,
          },
          medicationCodeableConcept: null,
        }),
    dispenseRequest,
  }
}

/**
 * Promote a carebook `MedicationDispense`: `medication-processor` → `location`,
 * and the UCUM day unit onto `daysSupply`.
 *
 * @remarks
 * `location` rather than `performer` because the reference denotes a
 * `Location`: the request path is `…/pharmacy/Location` and the extension's id
 * is that query's `_id`.
 */
const promoteMedicationDispense = (dispense: DispenseType): DispenseType => {
  const consumed = new Set<string>()

  const processorExtension = extensionAt(
    dispense.extension,
    CarebookExtension.DispenseMedicationProcessor
  )
  const location = decodeReference(processorExtension?.valueReference)
  if (Option.isSome(location)) consumed.add(CarebookExtension.DispenseMedicationProcessor)

  return {
    ...dispense,
    extension: withoutConsumed(dispense.extension, consumed),
    location: Option.isSome(location) ? location.value : dispense.location,
    daysSupply: withDayUnit(dispense.daysSupply),
  }
}

export { promoteMedicationDispense, promoteMedicationRequest }
