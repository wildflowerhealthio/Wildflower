import { Effect, Option, Schema } from 'effect'
import { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind, extractJson, recognizePortal } from 'http-extraction-fundamentals'

import { decodesAsDateTime, firstDateTime } from '../dates.ts'
import {
  PRESCRIPTION_STATUS_TYPE_SYSTEM,
  ShoppersIdentifierSystem,
  shoppersStoreLocatorUrl,
} from '../shoppers.ts'
import { SHOPPERS_DRUGMART_SYSTEM } from '../source-system.ts'
import { medicationWire } from './medication-wire.ts'

/**
 * Just-enough schema for one bespoke (non-FHIR) prescription-status payload. Only
 * `id` (→ `MedicationRequest.id`) and `patientId` (→ the `subject`) are required;
 * the rest is optional and lenient. `dispenses` is a flat array; the status flags
 * drive `MedicationRequest.status`.
 */
const SourcePrescription = Schema.Struct({
  id: Schema.String,
  patientId: Schema.String,
  prescriptionNumber: Schema.optional(Schema.Number),
  brandName: Schema.optional(Schema.String),
  chemicalName: Schema.optional(Schema.String),
  numFillsLeft: Schema.optional(Schema.Number),
  prescriberName: Schema.optional(Schema.String),
  status: Schema.optional(
    Schema.Struct({
      label: Schema.optional(Schema.String),
      portalLabel: Schema.optional(Schema.String),
      labelDescription: Schema.optional(Schema.String),
      // The portal's machine-readable status enum; the set is open, so a free string.
      type: Schema.optional(Schema.String),
    })
  ),
  din: Schema.optional(Schema.String),
  direction: Schema.optional(Schema.String),
  refillQuantity: Schema.optional(Schema.Number),
  expiryDate: Schema.optional(Schema.String),
  lastFillDate: Schema.optional(Schema.String),
  // `lastFillDate` / `nextFillDate` bound the fill window (see {@link dispenseRequestWire}).
  nextFillDate: Schema.optional(Schema.String),
  // The store id → the store-locator link on `supportingInformation`; lenient on
  // string vs number.
  storeId: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  // `expired`/`archived` drive `MedicationRequest.status` → `'stopped'`;
  // `renewable` is decoded but not mapped.
  expired: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  renewable: Schema.optional(Schema.Boolean),
  // The prior rx's number → an identifier-only `priorPrescription` reference (its
  // uuid is unknown).
  previousPrescription: Schema.optional(Schema.Number),
  dispenses: Schema.optional(Schema.Array(Schema.Unknown)),
})

type SourcePrescription = typeof SourcePrescription.Type

/** One dispense record inside a prescription's `dispenses` array. */
const SourceDispense = Schema.Struct({
  dispenseId: Schema.optional(Schema.String),
  quantityDispensed: Schema.optional(Schema.Number),
  status: Schema.optional(Schema.String),
  dispenseDate: Schema.optional(Schema.String),
})

type SourceDispense = typeof SourceDispense.Type

const decodePrescription = Schema.decode(Schema.parseJson(SourcePrescription))
const decodeSourceDispense = Schema.decodeUnknownOption(SourceDispense)
const decodeRequest = Schema.decodeUnknown(MedicationRequest.Schema)
const decodeDispense = Schema.decodeUnknown(MedicationDispense.Schema)

/** True for a value that is itself a dispense object (carries a `dispenseId`). */
const isDispenseLike = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && 'dispenseId' in value

/**
 * Unwrap a numeric-keyed dispense wrapper (`[{ "0": { dispenseId, … } }]` →
 * `[{ dispenseId, … }]`); an entry that already looks like a dispense, or any
 * other, passes through untouched. The `every(isDispenseLike)` guard is
 * load-bearing: without it a genuine `dispenseId`-less dispense is mistaken for
 * a wrapper and shredded into its scalar values. Never observed in a real
 * capture (flat arrays there) — retained as belt-and-braces.
 */
const flattenDispenses = (raw: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
  raw.flatMap((entry) => {
    if (entry !== null && typeof entry === 'object' && !('dispenseId' in entry)) {
      const values = Object.values(entry)
      if (values.length > 0 && values.every(isDispenseLike)) return values
    }
    return [entry]
  })

/** Map the portal dispense status onto the FHIR R4 `MedicationDispense.status` value set. */
const dispenseStatus = (status: string | undefined): string => {
  switch ((status ?? '').toUpperCase()) {
    case 'COMPLETE':
    case 'COMPLETED':
      return 'completed'
    case 'IN_PROGRESS':
    case 'IN-PROGRESS':
      return 'in-progress'
    case 'CANCELLED':
    case 'CANCELED':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** `Patient/{id}` reference wire object. */
const patientReference = (patientId: string): Record<string, unknown> => ({
  reference: `Patient/${patientId}`,
})

/** Build the R4 `MedicationRequest.dispenseRequest` wire, or `undefined` if it would be empty. */
const dispenseRequestWire = (rx: SourcePrescription): Record<string, unknown> | undefined => {
  const dr: Record<string, unknown> = {}
  if (rx.numFillsLeft != null && Number.isFinite(rx.numFillsLeft)) {
    const repeats = Math.trunc(rx.numFillsLeft)
    if (repeats >= 0) dr['numberOfRepeatsAllowed'] = repeats
  }
  if (rx.refillQuantity != null && Number.isFinite(rx.refillQuantity)) {
    dr['quantity'] = { value: rx.refillQuantity }
  }
  // The fill window: `lastFillDate` opens it, `nextFillDate` (else `expiryDate`) closes it.
  const validityStart = firstDateTime(rx.lastFillDate)
  const validityEnd = firstDateTime(rx.nextFillDate, rx.expiryDate)
  if (validityStart != null || validityEnd != null) {
    dr['validityPeriod'] = {
      ...(validityStart != null ? { start: validityStart } : {}),
      ...(validityEnd != null ? { end: validityEnd } : {}),
    }
  }
  return Object.keys(dr).length > 0 ? dr : undefined
}

/**
 * The `supportingInformation` wire: a `Reference` to the public store-locator URL
 * for the prescription's `storeId`; `undefined` when no store id is present.
 */
const supportingInformationWire = (
  rx: SourcePrescription
): ReadonlyArray<Record<string, unknown>> | undefined => {
  if (rx.storeId == null) return undefined
  const storeId = String(rx.storeId)
  if (storeId.length === 0) return undefined
  return [{ reference: shoppersStoreLocatorUrl(storeId) }]
}

/**
 * Map the portal's status flags onto `MedicationRequest.status`:
 * `expired`/`archived` → `'stopped'`, else `'unknown'`. Conservative — nothing
 * maps to `'active'` (the portal's enum asserts an affordance, not clinical
 * activity).
 */
const requestStatus = (rx: SourcePrescription): string =>
  rx.expired === true || rx.archived === true ? 'stopped' : 'unknown'

/**
 * The `statusReason` wire: the machine `status.type` as a coding under
 * {@link PRESCRIPTION_STATUS_TYPE_SYSTEM}, plus the human label as `text`;
 * `undefined` when neither is present.
 */
const statusReasonWire = (rx: SourcePrescription): Record<string, unknown> | undefined => {
  const type = rx.status?.type
  const text = rx.status?.portalLabel ?? rx.status?.label
  if (type == null && text == null) return undefined
  return {
    ...(type != null ? { coding: [{ system: PRESCRIPTION_STATUS_TYPE_SYSTEM, code: type }] } : {}),
    ...(text != null ? { text } : {}),
  }
}

/**
 * Build the R4 `MedicationRequest` **wire** from the decoded prescription; the
 * machine `status.type` / label ride `statusReason` and `note`, so nothing is
 * lost. Only slots the payload populates are emitted.
 */
const requestWire = (
  rx: SourcePrescription,
  medication: Record<string, unknown> | undefined
): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'MedicationRequest',
    id: rx.id,
    status: requestStatus(rx),
    intent: 'order',
    subject: patientReference(rx.patientId),
  }
  if (rx.prescriptionNumber != null) {
    wire['identifier'] = [
      {
        system: ShoppersIdentifierSystem.PrescriptionNumber,
        value: String(rx.prescriptionNumber),
      },
    ]
  }
  if (medication != null) wire['medicationCodeableConcept'] = medication
  if (rx.prescriberName != null) wire['requester'] = { display: rx.prescriberName }

  const statusReason = statusReasonWire(rx)
  if (statusReason != null) wire['statusReason'] = statusReason
  if (rx.status?.labelDescription != null) {
    wire['note'] = [{ text: rx.status.labelDescription }]
  }

  // The prior rx's number as an identifier-only reference (its uuid is unknown;
  // adoption leaves it untouched).
  if (rx.previousPrescription != null) {
    wire['priorPrescription'] = {
      identifier: {
        system: ShoppersIdentifierSystem.PrescriptionNumber,
        value: String(rx.previousPrescription),
      },
    }
  }

  // Only a *past* fill date stands in for `authoredOn` — `nextFillDate` is not a
  // fallback (see this package's AGENTS.md).
  const authoredOn = firstDateTime(rx.lastFillDate)
  if (authoredOn != null) wire['authoredOn'] = authoredOn
  if (rx.direction != null) wire['dosageInstruction'] = [{ text: rx.direction }]

  const supportingInformation = supportingInformationWire(rx)
  if (supportingInformation != null) wire['supportingInformation'] = supportingInformation

  const dispenseRequest = dispenseRequestWire(rx)
  if (dispenseRequest != null) wire['dispenseRequest'] = dispenseRequest
  return wire
}

/**
 * Build the R4 `MedicationDispense` **wire** for one dispense; `undefined` when
 * it has no `dispenseId` (so it drops-and-counts). `medication` is the
 * prescription-level concept, built once by the caller and shared.
 */
const dispenseWire = (
  dispense: SourceDispense,
  rx: SourcePrescription,
  medication: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  if (dispense.dispenseId == null) return undefined
  const wire: Record<string, unknown> = {
    resourceType: 'MedicationDispense',
    id: dispense.dispenseId,
    identifier: [{ system: ShoppersIdentifierSystem.DispenseId, value: dispense.dispenseId }],
    status: dispenseStatus(dispense.status),
    subject: patientReference(rx.patientId),
    authorizingPrescription: [{ reference: `MedicationRequest/${rx.id}` }],
  }
  if (medication != null) wire['medicationCodeableConcept'] = medication
  if (dispense.quantityDispensed != null && Number.isFinite(dispense.quantityDispensed)) {
    wire['quantity'] = { value: dispense.quantityDispensed }
  }
  if (decodesAsDateTime(dispense.dispenseDate)) wire['whenHandedOver'] = dispense.dispenseDate
  return wire
}

/**
 * The exact prescription-status XHR URL, anchored and pinned to host + `v1` +
 * full path with an optional query; only the `<uuid>` path parameter and query
 * vary. Disjoint from the sibling kinds.
 */
const prescriptionStatusUrl =
  /^https:\/\/mypharmacy\.shoppersdrugmart\.ca\/api\/v1\/prescriptions\/[^/?#]+\/prescription-status(?:\?|$)/

/**
 * Entity for one Shoppers prescription XHR: the `prescription-status` payload the
 * dashboard fires once **per prescription**. Each is one bespoke JSON object
 * synthesized into one **`MedicationRequest`** plus one **`MedicationDispense`**
 * per `dispenses` entry (one with no `dispenseId` drops-and-logs). **No
 * `Patient`** — the subject records come from {@link CustomerResponseKind}, so a
 * run where that XHR fails leaves these `subject` references dangling (tolerated;
 * not FK-enforced). No `followUpSteps`.
 */
const PrescriptionResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> =
  HttpResponseKind.make({
    name: 'PrescriptionResponseKind',
    tryRecognize: recognizePortal(prescriptionStatusUrl, SHOPPERS_DRUGMART_SYSTEM),
    parse: (response) =>
      Effect.gen(function* () {
        const rx = yield* decodePrescription(extractJson(response.text()))
        // The drug is named once on the prescription — build the concept once and share it.
        const medication = medicationWire(rx)
        const request = yield* decodeRequest(requestWire(rx, medication))

        const rawDispenses = flattenDispenses(rx.dispenses ?? [])
        const dispenses: Array<typeof MedicationDispense.Schema.Type> = []
        let dropped = 0
        for (const raw of rawDispenses) {
          const decoded = decodeSourceDispense(raw)
          const wire = Option.isSome(decoded)
            ? dispenseWire(decoded.value, rx, medication)
            : undefined
          if (wire === undefined) {
            dropped += 1
            continue
          }
          dispenses.push(yield* decodeDispense(wire))
        }
        if (dropped > 0) {
          yield* Effect.logInfo(
            `PrescriptionResponseKind: dropped ${dropped} of ${rawDispenses.length} dispense entries with no dispenseId (or undecodable)`
          )
        }

        return [request, ...dispenses]
      }),
  })

export { PrescriptionResponseKind, SourcePrescription, SourceDispense }
