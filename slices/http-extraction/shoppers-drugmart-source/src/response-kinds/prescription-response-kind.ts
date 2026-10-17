import { FhirString } from '@wildflowerhealthio/fhir-r4/data-types'
import { MedicationDispense, MedicationRequest } from '@wildflowerhealthio/fhir-r4/resources'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import {
  HttpResponseKind,
  extractJson,
  recognizePortal,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import {
  Array as Arr,
  DateTime,
  Duration,
  Effect,
  Option,
  pipe,
  RegExp as EffectRegExp,
  Schema,
} from 'effect'

import { dateTimeOf, decodesAsDateTime, firstDateTime } from '../dates.ts'
import { DecodableEntries } from '../lenient-schemas.ts'
import { portalGetMatcher, SHOPPERS_API_BASE_URL } from '../portal-url.ts'
import {
  PRESCRIPTION_STATUS_TYPE_SYSTEM,
  ShoppersIdentifierSystem,
  shoppersStoreDisplay,
  shoppersStoreLocatorUrl,
} from '../shoppers.ts'
import { SHOPPERS_DRUGMART_SYSTEM } from '../source-system.ts'
import { medicationWire } from './medication-wire.ts'

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

/**
 * One dispense record inside a prescription's `dispenses` array; every field
 * optional, and `null` reads as absent.
 */
const SourceDispense = Schema.Struct({
  dispenseId: Schema.optionalWith(Schema.String, { nullable: true }),
  quantityDispensed: Schema.optionalWith(Schema.Number, { nullable: true }),
  status: Schema.optionalWith(Schema.String, { nullable: true }),
  dispenseDate: Schema.optionalWith(Schema.String, { nullable: true }),
})

type SourceDispense = typeof SourceDispense.Type

/**
 * Just-enough schema for one bespoke (non-FHIR) prescription-status payload. Only
 * `id` (→ `MedicationRequest.id`) and `patientId` (→ the `subject`) are required;
 * the rest is optional and lenient, and reads `null` as absent. `dispenses` is a
 * flat array decoded entry by entry ({@link DecodableEntries}): an entry that is
 * not a {@link SourceDispense} is counted, not decoded, and never fails the
 * payload. The status flags drive `MedicationRequest.status`.
 */
const SourcePrescription = Schema.Struct({
  id: Schema.String,
  patientId: Schema.String,
  prescriptionNumber: Schema.optionalWith(Schema.Number, { nullable: true }),
  brandName: Schema.optionalWith(Schema.String, { nullable: true }),
  chemicalName: Schema.optionalWith(Schema.String, { nullable: true }),
  numFillsLeft: Schema.optionalWith(Schema.Number, { nullable: true }),
  prescriberName: Schema.optionalWith(Schema.String, { nullable: true }),
  status: Schema.optionalWith(
    Schema.Struct({
      label: Schema.optionalWith(Schema.String, { nullable: true }),
      portalLabel: Schema.optionalWith(Schema.String, { nullable: true }),
      labelDescription: Schema.optionalWith(Schema.String, { nullable: true }),
      // The portal's machine-readable status enum; the set is open, so a free string.
      type: Schema.optionalWith(Schema.String, { nullable: true }),
    }),
    { nullable: true }
  ),
  din: Schema.optionalWith(Schema.String, { nullable: true }),
  direction: Schema.optionalWith(Schema.String, { nullable: true }),
  refillQuantity: Schema.optionalWith(Schema.Number, { nullable: true }),
  expiryDate: Schema.optionalWith(Schema.String, { nullable: true }),
  lastFillDate: Schema.optionalWith(Schema.String, { nullable: true }),
  // `lastFillDate` / `nextFillDate` bound the fill window and the supply one fill
  // lasts (see {@link dispenseRequestWire}).
  nextFillDate: Schema.optionalWith(Schema.String, { nullable: true }),
  // The store id → the store-locator link on `dispenseRequest.performer` (and
  // each dispense's `location`); lenient on string vs number.
  storeId: Schema.optionalWith(Schema.Union(Schema.String, Schema.Number), { nullable: true }),
  // `expired`/`archived` drive `MedicationRequest.status` (see {@link requestStatus});
  // `renewable` is decoded but not mapped.
  expired: Schema.optionalWith(Schema.Boolean, { nullable: true }),
  archived: Schema.optionalWith(Schema.Boolean, { nullable: true }),
  renewable: Schema.optionalWith(Schema.Boolean, { nullable: true }),
  // The prior rx's number → an identifier-only `priorPrescription` reference (its
  // uuid is unknown).
  previousPrescription: Schema.optionalWith(Schema.Number, { nullable: true }),
  dispenses: Schema.optionalWith(DecodableEntries(SourceDispense, flattenDispenses), {
    nullable: true,
  }),
})

type SourcePrescription = typeof SourcePrescription.Type

const decodePrescription = Schema.decode(Schema.parseJson(SourcePrescription))
const decodeRequest = Schema.decodeUnknown(MedicationRequest.Schema)
const decodeDispense = Schema.decodeUnknown(MedicationDispense.Schema)

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

/** UCUM, the code system FHIR quantities use for units of measure. */
const UCUM_SYSTEM = 'http://unitsofmeasure.org'

/**
 * The days one fill's supply lasts: from `lastFillDate` to `nextFillDate`,
 * rounded to whole days; `undefined` unless both decode as date-times and the
 * span comes to at least one day.
 */
const supplyDaysPerFillOf = (rx: SourcePrescription): number | undefined =>
  pipe(
    Option.all({ lastFill: dateTimeOf(rx.lastFillDate), nextFill: dateTimeOf(rx.nextFillDate) }),
    Option.map(({ lastFill, nextFill }) =>
      // `distance` is signed, so a `nextFillDate` before `lastFillDate` stays negative.
      Math.round(DateTime.distance(lastFill, nextFill) / Duration.toMillis(Duration.days(1)))
    ),
    Option.filter((supplyDays) => supplyDays > 0),
    Option.getOrUndefined
  )

/** Build the R4 `MedicationRequest.dispenseRequest` wire, or `undefined` if it would be empty. */
const dispenseRequestWire = (rx: SourcePrescription): Record<string, unknown> | undefined => {
  const dr: Record<string, unknown> = {}
  const store = storeReferenceWire(rx)
  if (store != null) dr['performer'] = store
  if (rx.numFillsLeft != null && Number.isFinite(rx.numFillsLeft)) {
    const repeats = Math.trunc(rx.numFillsLeft)
    if (repeats >= 0) dr['numberOfRepeatsAllowed'] = repeats
  }
  if (rx.refillQuantity != null && Number.isFinite(rx.refillQuantity)) {
    dr['quantity'] = { value: rx.refillQuantity }
  }
  const supplyDaysPerFill = supplyDaysPerFillOf(rx)
  if (supplyDaysPerFill != null) {
    dr['expectedSupplyDuration'] = {
      value: supplyDaysPerFill,
      unit: 'day',
      system: UCUM_SYSTEM,
      code: 'd',
    }
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
 * The dispensing store as a `Reference` to its public store-locator URL, named
 * after its store number — the wire for both `dispenseRequest.performer` and
 * each dispense's `location`; `undefined` when no store id is present.
 */
const storeReferenceWire = (rx: SourcePrescription): Record<string, unknown> | undefined => {
  if (rx.storeId == null) return undefined
  const storeId = String(rx.storeId)
  if (storeId.length === 0) return undefined
  return { reference: shoppersStoreLocatorUrl(storeId), display: shoppersStoreDisplay(storeId) }
}

/**
 * Map the portal's status flags onto `MedicationRequest.status`: a prescription
 * that is `expired` or `archived` is `'stopped'`, and any other is a current
 * prescription, `'active'`. The portal's `status.type` (what the dashboard
 * offers next, such as a refill or a renewal) does not affect it.
 */
const requestStatus = (rx: SourcePrescription): string =>
  rx.expired === true || rx.archived === true ? 'stopped' : 'active'

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
  // `Annotation.text` is a required FHIR string, so a blank description would
  // fail the request's decode; it is written only when it holds text.
  const labelDescription = rx.status?.labelDescription
  if (labelDescription != null && !FhirString.isBlank(labelDescription)) {
    wire['note'] = [{ text: labelDescription }]
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
  const location = storeReferenceWire(rx)
  if (location != null) wire['location'] = location
  return wire
}

/**
 * The exact prescription-status XHR URL (`prescriptionStatusUrlOf`), anchored
 * and pinned to {@link SHOPPERS_API_BASE_URL} + full path with an optional
 * query; only the `<uuid>` path parameter and query vary. Disjoint from the
 * sibling kinds.
 */
const prescriptionStatusUrl = new RegExp(
  `^${EffectRegExp.escape(SHOPPERS_API_BASE_URL)}/prescriptions/[^/?#]+/prescription-status(?:\\?|$)`
)

/**
 * Entity for one Shoppers prescription XHR: the `prescription-status` payload the
 * dashboard fires once **per prescription**. Each is one bespoke JSON object
 * synthesized into one **`MedicationRequest`** plus one **`MedicationDispense`**
 * per `dispenses` entry. A dispense entry that does not decode as a
 * {@link SourceDispense} (a `quantityDispensed` sent as a string, say, or an
 * entry that is not an object), and one with no `dispenseId` (absent or
 * `null`), drops-and-counts via `Effect.logInfo`; the `MedicationRequest` and
 * the other dispenses are still emitted. **No
 * `Patient`** — the subject records come from {@link CustomerResponseKind}, so a
 * run where that XHR fails leaves these `subject` references dangling (tolerated;
 * not FK-enforced).
 */
const PrescriptionResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> =
  HttpResponseKind.make({
    name: 'PrescriptionResponseKind',
    tryRecognize: recognizePortal(
      portalGetMatcher(prescriptionStatusUrl),
      SHOPPERS_DRUGMART_SYSTEM
    ),
    parse: (response) =>
      Effect.gen(function* () {
        const rx = yield* decodePrescription(extractJson(response.text()))
        // The drug is named once on the prescription — build the concept once and share it.
        const medication = medicationWire(rx)
        const request = yield* decodeRequest(requestWire(rx, medication))

        const { decoded, undecodable } = rx.dispenses ?? { decoded: [], undecodable: 0 }
        const dispenseWires = Arr.filterMap(decoded, (dispense) =>
          Option.fromNullable(dispenseWire(dispense, rx, medication))
        )
        const withoutId = decoded.length - dispenseWires.length
        const dispenses = yield* Effect.forEach(dispenseWires, (wire) => decodeDispense(wire))
        if (undecodable + withoutId > 0) {
          yield* Effect.logInfo(
            `PrescriptionResponseKind: dropped ${undecodable + withoutId} of ${undecodable + decoded.length} dispense entries (${undecodable} undecodable, ${withoutId} with no dispenseId)`
          )
        }

        return [request, ...dispenses]
      }),
  })

export { PrescriptionResponseKind, SourcePrescription, SourceDispense }
