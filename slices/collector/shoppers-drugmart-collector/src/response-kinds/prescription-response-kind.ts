import { Effect, Option, Schema } from 'effect'
import { MedicationDispense, MedicationRequest } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind } from 'http-extraction-fundamentals'

import { decodesAsDateTime, firstDateTime } from '../dates.ts'
import { extractJson } from '../extract-json.ts'
import {
  PRESCRIPTION_STATUS_TYPE_SYSTEM,
  ShoppersIdentifierSystem,
  shoppersStoreLocatorUrl,
} from '../shoppers.ts'
import { medicationWire } from './medication-wire.ts'

/**
 * Just-enough schema for one `…/api/<seg>/prescriptions/:uuid/prescription-status`
 * payload — a bespoke portal JSON shape, **not FHIR**. Only `id` (the
 * prescription's uuid → `MedicationRequest.id`) and `patientId` (→ the
 * `subject` reference) are required; everything else is optional and lenient
 * (unknown fields are dropped on decode), so a field the capture omits simply
 * leaves its R4 slot at the schema default rather than failing the decode.
 *
 * The shape is reconciled against a redacted real capture. `dispenses` is a
 * **flat** array of `{ dispenseId, quantityDispensed, status, dispenseDate }`;
 * {@link flattenDispenses} is retained only as belt-and-braces (see its remark).
 * `status.type` is a machine enum and the top-level `expired`/`archived`/
 * `renewable` flags drive `MedicationRequest.status` (see {@link requestWire}).
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
      // The portal's machine-readable status enum (`READY_FOR_RENEW`,
      // `UNABLE_TO_RENEW_ONLINE`, `READY_FOR_REFILL_NO_DISPENSE`, …). The set is
      // open, so it is a free string, not a literal union.
      type: Schema.optional(Schema.String),
    })
  ),
  din: Schema.optional(Schema.String),
  direction: Schema.optional(Schema.String),
  refillQuantity: Schema.optional(Schema.Number),
  expiryDate: Schema.optional(Schema.String),
  lastFillDate: Schema.optional(Schema.String),
  // Only ever one of `lastFillDate` / `nextFillDate` is observed on a payload;
  // together they bound the fill window (see {@link dispenseRequestWire}).
  nextFillDate: Schema.optional(Schema.String),
  // The dispensing store's numeric id → the `…/store-locator/store/:id` link on
  // `supportingInformation` (see {@link supportingInformationWire}). Lenient on
  // string vs number since the portal's typing of it is unconfirmed.
  storeId: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  // Top-level status flags. `expired`/`archived` drive `MedicationRequest.status`
  // → `'stopped'`; `renewable` is decoded for completeness but not mapped (it
  // asserts a renewal affordance, not a clinical state).
  expired: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
  renewable: Schema.optional(Schema.Boolean),
  // The prior prescription's human-facing number → an identifier-only
  // `priorPrescription` reference (see {@link requestWire}). We don't know the
  // prior rx's uuid, so there is no relative reference to write.
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
 * `[{ dispenseId, … }]`). An entry that already looks like a dispense (has a
 * `dispenseId`) passes through untouched, and so does any other entry —
 * including an object whose values are *not* all dispenses. Non-object entries
 * pass through so a malformed one is dropped downstream by
 * {@link decodeSourceDispense} rather than here.
 *
 * @remarks
 * The `every(isDispenseLike)` guard is load-bearing: without it a genuine but
 * `dispenseId`-less dispense (`{ quantityDispensed: 5, status: 'COMPLETE' }`)
 * is mistaken for a wrapper and shredded into its scalar values, turning one
 * dropped entry into several and destroying the entry the drop count reports on.
 *
 * The numeric-key wrapper was **never observed** in the real capture —
 * `dispenses` is a flat array there. This helper is retained purely as
 * belt-and-braces (it passes a flat array through untouched), not because
 * captures use the wrapper.
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
  // The fill window: `lastFillDate` opens it (`start`), `nextFillDate` closes it
  // (`end`). `nextFillDate` takes precedence over the prescription `expiryDate`
  // for `end`, which remains the fallback when no next-fill date is present.
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
 * The `supportingInformation` wire: a single `Reference` whose `reference` is
 * the public Shoppers store-locator URL for the prescription's `storeId`
 * (`…/store-locator/store/:id`). `undefined` when no (non-empty) store id is
 * present, so the caller omits the slot.
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
 * Map the portal's top-level status flags onto the FHIR R4
 * `MedicationRequest.status` value set. `expired` or `archived` → `'stopped'`;
 * everything else stays `'unknown'`. Deliberately conservative — nothing maps to
 * `'active'`, because the portal's enum asserts a renewal/refill affordance, not
 * clinical activity.
 */
const requestStatus = (rx: SourcePrescription): string =>
  rx.expired === true || rx.archived === true ? 'stopped' : 'unknown'

/**
 * The `statusReason` wire: the portal's machine `status.type` as a coding under
 * {@link PRESCRIPTION_STATUS_TYPE_SYSTEM}, plus the human label as `text`.
 * `undefined` when the payload carries neither, so the caller omits the slot.
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
 * Build the FHIR R4 `MedicationRequest` **wire** object from the decoded
 * prescription. `status` is `'stopped'` for an expired/archived prescription and
 * `'unknown'` otherwise (see {@link requestStatus}); the portal's machine
 * `status.type` and human label ride `statusReason` and its longer description a
 * `note`, so nothing is lost. Only slots the payload populates are emitted.
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

  // The prior prescription's number, as an identifier-only reference (no
  // `reference` field): we don't know the prior rx's uuid, and adoption leaves an
  // identifier-only reference untouched.
  if (rx.previousPrescription != null) {
    wire['priorPrescription'] = {
      identifier: {
        system: ShoppersIdentifierSystem.PrescriptionNumber,
        value: String(rx.previousPrescription),
      },
    }
  }

  // Only a *past* fill date can stand in for "when the request was initially
  // authored" — `nextFillDate` is deliberately not a fallback (see the resource
  // mapping notes in this package's AGENTS.md).
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
 * Build the FHIR R4 `MedicationDispense` **wire** object for one dispense of a
 * prescription. Returns `undefined` when the dispense has no `dispenseId` (there
 * is no logical id to write it under, so it is dropped-and-counted rather than
 * silently skipped at the persist sink).
 *
 * `medication` is the prescription-level `medicationCodeableConcept`, built once
 * by the caller: the status payload names the drug on the prescription, not
 * per-dispense, so rebuilding it inside the loop produced N identical objects.
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
 * `…://host/…/prescriptions/<uuid>/prescription-status`. Hand-rolled (not
 * `UrlMatch.make`) so it tolerates an optional trailing slash / query and stays
 * disjoint from {@link !CustomerResponseKind}'s `…/customers/<uuid>` pattern and
 * {@link !PrescriptionHistoryResponseKind}'s `…/prescription-history?customerId=…`
 * pattern (different path segments) — entity order is therefore not
 * load-bearing.
 */
const prescriptionStatusUrl =
  /:\/\/[^/]+(?:\/[^/?#]+)*?\/prescriptions\/[^/?#]+\/prescription-status\/?(?:[?#]|$)/

/**
 * Entity for one Shoppers prescription XHR: the `…/prescriptions/:uuid/prescription-status`
 * payload the prescription-dashboard page fires once **per prescription**. Each
 * response is a single bespoke JSON object (not FHIR), synthesized here into:
 *
 * - one **`MedicationRequest`** (`status` from the expired/archived flags,
 *   otherwise `'unknown'`; the machine `status.type` and portal label kept in
 *   `statusReason` / `note`); and
 * - one **`MedicationDispense`** per entry in `dispenses`. A dispense with no
 *   `dispenseId` has no logical id to write under, so it is dropped and the loss
 *   surfaced via `Effect.logInfo` rather than silently skipped.
 *
 * **No `Patient`.** The subject Patient records now come from
 * {@link !CustomerResponseKind} (the customers XHR fires on the same run), so the
 * `subject: Patient/<patientId>` references here resolve to the demographic
 * Patient that entity emits — this entity no longer synthesizes a minimal stub.
 * The trade-off: a run where the customers XHR fails leaves those `subject`
 * references dangling, which the store tolerates (references are not
 * FK-enforced).
 *
 * The prescription-dashboard fans out one status XHR per prescription and this
 * entity sniffs each — no per-prescription detail crawl (`followUpSteps`) is
 * emitted. {@link extractJson} normalizes the body across raw-XHR intercepts and
 * the mobile WebView's JSON-viewer wrap.
 */
const PrescriptionResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> =
  HttpResponseKind.make({
    name: 'PrescriptionResponseKind',
    isFoundAt: (url) => prescriptionStatusUrl.test(url),
    parse: (response) =>
      Effect.gen(function* () {
        const rx = yield* decodePrescription(extractJson(response.text()))
        // The status payload names the drug once, on the prescription — build the
        // concept once and share it with the request and every dispense.
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
