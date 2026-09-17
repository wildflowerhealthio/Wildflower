import { DateTime, Either, Schema } from 'effect'

import { choiceElementSetPassthroughFields, ChoiceElementSet } from 'fhir-r4/data-types'

/**
 * The one-line description one previewed FHIR resource is listed under, on its
 * own row inside the URL group it came from. Pure — the review body reads it,
 * and the summaries are asserted per resource type in this module's test.
 *
 * @remarks
 * Accepts `unknown` because the shell threads generic previews
 * (`PreviewedResource<unknown>`) even though the HAR binding pins
 * a `FhirResource` at runtime. The read is a per-type Effect Schema
 * decode against the summary fields we care about (never the whole resource),
 * so a partial or mis-typed field folds cleanly to `''` instead of throwing,
 * and the summary falls back to `resourceType/id` when nothing survives.
 *
 * @packageDocumentation
 */

/** One resource's description: its type (a heading label) and a one-line summary. */
interface ResourceDescription {
  readonly type: string
  readonly summary: string
}

/** The permissive shape every resource shares — enough to read the type and id. */
const ResourceHeader = Schema.Struct({
  resourceType: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
})

/**
 * The `HumanName` fields the summaries read — the shared shape a Patient and a
 * Practitioner both carry, so both summaries reference it rather than repeating
 * it.
 */
const HumanNames = Schema.Array(
  Schema.Struct({
    text: Schema.optional(Schema.String),
    given: Schema.optional(Schema.Array(Schema.String)),
    family: Schema.optional(Schema.String),
  })
)

/** The Patient summary fields. */
const PatientSummary = Schema.Struct({
  name: Schema.optional(HumanNames),
  birthDate: Schema.optional(Schema.String),
})

/** The MedicationRequest / MedicationDispense summary fields. */
const MedicationSummary = Schema.Struct({
  status: Schema.optional(Schema.String),
  medicationCodeableConcept: Schema.optional(
    Schema.Struct({
      text: Schema.optional(Schema.String),
      coding: Schema.optional(
        Schema.Array(
          Schema.Struct({
            display: Schema.optional(Schema.String),
            code: Schema.optional(Schema.String),
          })
        )
      ),
    })
  ),
})

/** A shared CodeableConcept summary shape used by Observation.code / value. */
const CodeableFields = Schema.Struct({
  text: Schema.optional(Schema.String),
  coding: Schema.optional(
    Schema.Array(
      Schema.Struct({
        display: Schema.optional(Schema.String),
        code: Schema.optional(Schema.String),
      })
    )
  ),
})

/** The DiagnosticReport summary fields. */
const DiagnosticReportSummary = Schema.Struct({
  code: Schema.optional(CodeableFields),
  status: Schema.optional(Schema.String),
  ...choiceElementSetPassthroughFields(
    'effective',
    ChoiceElementSet.FhirR4SetChoices['DiagnosticReport.effective[x]']
  ),
  result: Schema.optional(Schema.Array(Schema.Struct({}))),
})

/** The Practitioner summary fields — its names, the same shape a Patient carries. */
const PractitionerSummary = Schema.Struct({
  name: Schema.optional(HumanNames),
})

/** The Observation summary fields. */
const ObservationSummary = Schema.Struct({
  code: Schema.optional(CodeableFields),
  valueCodeableConcept: Schema.optional(CodeableFields),
  valueQuantity: Schema.optional(
    Schema.Struct({
      value: Schema.optional(Schema.Number),
      unit: Schema.optional(Schema.String),
      code: Schema.optional(Schema.String),
    })
  ),
  valueString: Schema.optional(Schema.String),
})

/** Decode a resource against `schema`, folding a decode error to `undefined`. */
const decode = <A, I>(schema: Schema.Schema<A, I>, resource: unknown): A | undefined => {
  const result = Schema.decodeUnknownEither(schema)(resource)
  return Either.isRight(result) ? result.right : undefined
}

/** A parsed FHIR resource's `id`, or `'?'` when it was omitted. */
const idOrUnknown = (id: string | undefined): string =>
  id === undefined || id.length === 0 ? '?' : id

/** The reviewer-recognisable name of a HumanName, `given family` when present, else `text`. */
const humanNameText = (name: {
  readonly text?: string
  readonly given?: readonly string[]
  readonly family?: string
}): string => {
  const given = (name.given ?? []).join(' ').trim()
  const family = (name.family ?? '').trim()
  const joined = [given, family].filter((part) => part.length > 0).join(' ')
  if (joined.length > 0) return joined
  return (name.text ?? '').trim()
}

/** A CodeableConcept's user-facing text: prefer `text`, else `coding.display`, else `coding.code`. */
const codeableText = (concept: typeof CodeableFields.Type | undefined): string => {
  if (concept === undefined) return ''
  const text = (concept.text ?? '').trim()
  if (text.length > 0) return text
  for (const coding of concept.coding ?? []) {
    const display = (coding.display ?? '').trim()
    if (display.length > 0) return display
    const code = (coding.code ?? '').trim()
    if (code.length > 0) return code
  }
  return ''
}

/** A Quantity's display: `value unit`, or just one of them, or empty. */
const quantityText = (
  quantity: { readonly value?: number; readonly unit?: string; readonly code?: string } | undefined
): string => {
  if (quantity === undefined) return ''
  const value = quantity.value === undefined ? '' : String(quantity.value)
  const unit = (quantity.unit ?? quantity.code ?? '').trim()
  return [value, unit].filter((part) => part.length > 0).join(' ')
}

/** Join reviewer-facing parts with a middle dot, dropping empties. */
const joinSummary = (parts: readonly string[]): string =>
  parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' · ')

/**
 * Read just a resource's `resourceType` — the cheap tally-only path that skips
 * every per-type decode {@link describeResource} does. Falls back to
 * `'Unknown'` when the field is missing or not a string; the reviewer's
 * per-type tally reads it once per resource on every render.
 */
const resourceTypeOf = (resource: unknown): string => {
  if (typeof resource !== 'object' || resource === null || !('resourceType' in resource)) {
    return 'Unknown'
  }
  const value: unknown = (resource as { readonly resourceType: unknown }).resourceType
  return typeof value === 'string' ? value : 'Unknown'
}

/**
 * Describe one FHIR resource for the interactive review. Pure and total —
 * never throws on a partially-decoded resource, always returns a
 * {@link ResourceDescription} the row can render.
 */
const describeResource = (resource: unknown): ResourceDescription => {
  const header = decode(ResourceHeader, resource) ?? {}
  const resourceType = header.resourceType ?? 'Unknown'
  const fallback = `${resourceType}/${idOrUnknown(header.id)}`
  switch (resourceType) {
    case 'Patient': {
      const patient = decode(PatientSummary, resource)
      const primary = (patient?.name ?? []).map(humanNameText).find((text) => text.length > 0) ?? ''
      const birthDate = (patient?.birthDate ?? '').trim()
      const summary = joinSummary([primary, birthDate])
      return {
        type: 'Patient',
        summary: summary.length > 0 ? summary : fallback,
      }
    }
    case 'MedicationRequest': {
      const medication = decode(MedicationSummary, resource)
      const medicationText = codeableText(medication?.medicationCodeableConcept)
      const status = (medication?.status ?? '').trim()
      const summary = joinSummary([medicationText, status])
      return {
        type: 'MedicationRequest',
        summary: summary.length > 0 ? summary : fallback,
      }
    }
    case 'MedicationDispense': {
      const medication = decode(MedicationSummary, resource)
      const medicationText = codeableText(medication?.medicationCodeableConcept)
      const status = (medication?.status ?? '').trim()
      const summary = joinSummary([medicationText, status])
      return {
        type: 'MedicationDispense',
        summary: summary.length > 0 ? summary : fallback,
      }
    }
    case 'Observation': {
      const observation = decode(ObservationSummary, resource)
      const code = codeableText(observation?.code)
      const valueQuantity = quantityText(observation?.valueQuantity)
      const valueCode = codeableText(observation?.valueCodeableConcept)
      const valueString = (observation?.valueString ?? '').trim()
      const value =
        [valueQuantity, valueCode, valueString].find((part) => part.trim().length > 0) ?? ''
      const summary = joinSummary([code, value])
      return {
        type: 'Observation',
        summary: summary.length > 0 ? summary : fallback,
      }
    }
    case 'DiagnosticReport': {
      const report = decode(DiagnosticReportSummary, resource)
      const code = codeableText(report?.code)
      const effectiveDateTime = report?.effectiveDateTime
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- SchemaFor<'Period'> is `Schema<any>` for complex types; the Period fields (start/end) are DateTime.Utc by construction.
      const effectivePeriod = report?.effectivePeriod
      let effective = ''
      if (effectiveDateTime != null) {
        effective = DateTime.formatIso(effectiveDateTime)
      } else if (effectivePeriod != null) {
        const start = effectivePeriod.start != null ? DateTime.formatIso(effectivePeriod.start) : ''
        const end = effectivePeriod.end != null ? DateTime.formatIso(effectivePeriod.end) : ''
        effective = [start, end].filter((part) => part.length > 0).join(' – ')
      }
      const results = report?.result ?? []
      const resultCount =
        results.length === 0
          ? ''
          : `${results.length} ${results.length === 1 ? 'result' : 'results'}`
      const status = (report?.status ?? '').trim()
      const summary = joinSummary([code, effective, resultCount, status])
      return {
        type: 'DiagnosticReport',
        summary: summary.length > 0 ? summary : fallback,
      }
    }
    case 'Practitioner': {
      const practitioner = decode(PractitionerSummary, resource)
      const primary =
        (practitioner?.name ?? []).map(humanNameText).find((text) => text.length > 0) ?? ''
      return {
        type: 'Practitioner',
        summary: primary.length > 0 ? primary : fallback,
      }
    }
    default:
      return { type: resourceType, summary: fallback }
  }
}

export { describeResource, resourceTypeOf, type ResourceDescription }
