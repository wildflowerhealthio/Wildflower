import { EntityDefinition } from 'collector-fundamentals/model'
import { Effect, Option, Schema } from 'effect'
import { MedicationDispense, MedicationRequest, Patient } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'

import { extractJson } from '../extract-json.ts'
import { DIN_CODE_SYSTEM, ShoppersIdentifierSystem, shoppersStoreLocatorUrl } from '../shoppers.ts'

/**
 * Just-enough schema for one `…/api/v1/prescriptions/:uuid/prescription-status`
 * payload — a bespoke portal JSON shape, **not FHIR**. Only `id` (the
 * prescription's uuid → `MedicationRequest.id`) and `patientId` (→ the
 * `subject` reference) are required; everything else is optional and lenient
 * (unknown fields are dropped on decode), so a field the capture omits simply
 * leaves its R4 slot at the schema default rather than failing the decode.
 *
 * `dispenses` is decoded as an array of `Unknown` and normalized in code: real
 * captures wrap each dispense in a numeric-keyed object
 * (`[{ "0": { dispenseId, … } }]`), so {@link flattenDispenses} unwraps that
 * before per-entry decode. **OPEN QUESTION** — the exact `dispenses` shape is
 * synthesized from the ticket's notes; reconcile against a redacted capture.
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
const decodePatient = Schema.decodeUnknown(Patient.Schema)
const decodeRequest = Schema.decodeUnknown(MedicationRequest.Schema)
const decodeDispense = Schema.decodeUnknown(MedicationDispense.Schema)

/** True iff `value` decodes as a FHIR R4 date-time (so it can ride a wire slot). */
const decodesAsDateTime = (value: string | undefined): value is string =>
  value != null && Option.isSome(Schema.decodeUnknownOption(Schema.DateTimeUtc)(value))

/** The first of `values` that decodes as a FHIR date-time, else `undefined`. */
const firstDateTime = (...values: Array<string | undefined>): string | undefined =>
  values.find(decodesAsDateTime)

/**
 * Unwrap the numeric-keyed dispense wrappers real captures use
 * (`[{ "0": { dispenseId, … } }]` → `[{ dispenseId, … }]`). An entry that
 * already looks like a dispense (has a `dispenseId`) passes through untouched;
 * any other object contributes its values. Non-object entries pass through so a
 * malformed one is dropped downstream by {@link decodeSourceDispense} rather
 * than here.
 */
const flattenDispenses = (raw: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
  raw.flatMap((entry) => {
    if (entry !== null && typeof entry === 'object' && !('dispenseId' in entry)) {
      return Object.values(entry)
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

/**
 * The `medicationCodeableConcept` wire shape shared by the request and its
 * dispenses: `text` from the brand (falling back to the chemical) name, plus a
 * DIN coding when the payload carries one. Returns `undefined` when the payload
 * names no medication at all, so the caller omits the slot entirely.
 */
const medicationWire = (rx: SourcePrescription): Record<string, unknown> | undefined => {
  const text = rx.brandName ?? rx.chemicalName
  const coding =
    rx.din != null
      ? [
          {
            system: DIN_CODE_SYSTEM,
            code: rx.din,
            ...(rx.chemicalName != null ? { display: rx.chemicalName } : {}),
          },
        ]
      : []
  if (text == null && coding.length === 0) return undefined
  return {
    ...(coding.length > 0 ? { coding } : {}),
    ...(text != null ? { text } : {}),
  }
}

/** `Patient/{id}` reference wire object. */
const patientReference = (patientId: string): Record<string, unknown> => ({
  reference: `Patient/${patientId}`,
})

/**
 * The minimal R4 `Patient` for a prescription's `patientId` — the id
 * `MedicationRequest.subject` resolves to. Demographics come from the *profile*
 * (a separate Patient keyed by `pcId`); the two ids don't align and can't be
 * joined here (see {@link ProfileEntity}), so this record carries only the
 * `patientId` (as id + identifier) to keep the subject reference resolvable.
 */
const minimalPatientWire = (patientId: string): Record<string, unknown> => ({
  resourceType: 'Patient',
  id: patientId,
  identifier: [{ system: ShoppersIdentifierSystem.PatientId, value: patientId }],
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
 * Build the FHIR R4 `MedicationRequest` **wire** object from the decoded
 * prescription. `status` is `'unknown'` (the portal's free-text status label is
 * not a FHIR code); the portal label is preserved in `statusReason.text` and its
 * longer description in a `note` so nothing is lost. Only slots the payload
 * populates are emitted.
 */
const requestWire = (rx: SourcePrescription): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'MedicationRequest',
    id: rx.id,
    status: 'unknown',
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
  const medication = medicationWire(rx)
  if (medication != null) wire['medicationCodeableConcept'] = medication
  if (rx.prescriberName != null) wire['requester'] = { display: rx.prescriberName }

  const statusLabel = rx.status?.portalLabel ?? rx.status?.label
  if (statusLabel != null) wire['statusReason'] = { text: statusLabel }
  if (rx.status?.labelDescription != null) {
    wire['note'] = [{ text: rx.status.labelDescription }]
  }

  // `authoredOn` prefers `lastFillDate`, falling back to `nextFillDate` when a
  // payload carries only the latter — the two are never both present.
  const authoredOn = firstDateTime(rx.lastFillDate, rx.nextFillDate)
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
 */
const dispenseWire = (
  dispense: SourceDispense,
  rx: SourcePrescription
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
  const medication = medicationWire(rx)
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
 * disjoint from {@link ProfileEntity}'s `…/profile/getProfile/` pattern —
 * entity order is therefore not load-bearing.
 */
const prescriptionStatusUrl =
  /:\/\/[^/]+(?:\/[^/?#]+)*?\/prescriptions\/[^/?#]+\/prescription-status\/?(?:[?#]|$)/

/**
 * Entity for one Shoppers prescription XHR: the `…/prescriptions/:uuid/prescription-status`
 * payload the prescription-dashboard page fires once **per prescription**. Each
 * response is a single bespoke JSON object (not FHIR), synthesized here into:
 *
 * - a **minimal `Patient`** keyed by the payload's `patientId` (the id
 *   `subject` resolves to — demographics live on the separate profile Patient
 *   keyed by `pcId`, which does not align; see {@link ProfileEntity});
 * - one **`MedicationRequest`** (`status: 'unknown'`, portal label kept in
 *   `statusReason` / `note`); and
 * - one **`MedicationDispense`** per entry in `dispenses` (numeric-keyed
 *   wrappers unwrapped by {@link flattenDispenses}). A dispense with no
 *   `dispenseId` has no logical id to write under, so it is dropped and the loss
 *   surfaced via `Effect.logInfo` rather than silently skipped.
 *
 * v1 is **list-only** in the sense that the prescription-dashboard fans out one
 * status XHR per prescription and this entity sniffs each — no per-prescription
 * detail crawl (`followUpSteps`) is emitted. {@link extractJson} normalizes the
 * body across raw-XHR intercepts and the mobile WebView's JSON-viewer wrap.
 */
const PrescriptionEntity: EntityDefinition.EntityDefinition<FhirResource> = EntityDefinition.make({
  name: 'PrescriptionEntity',
  isFoundAt: (url) => prescriptionStatusUrl.test(url),
  parse: (response) =>
    Effect.gen(function* () {
      const rx = yield* decodePrescription(extractJson(response.text()))
      const patient = yield* decodePatient(minimalPatientWire(rx.patientId))
      const request = yield* decodeRequest(requestWire(rx))

      const rawDispenses = flattenDispenses(rx.dispenses ?? [])
      const dispenses: Array<typeof MedicationDispense.Schema.Type> = []
      let dropped = 0
      for (const raw of rawDispenses) {
        const decoded = decodeSourceDispense(raw)
        const wire = Option.isSome(decoded) ? dispenseWire(decoded.value, rx) : undefined
        if (wire === undefined) {
          dropped += 1
          continue
        }
        dispenses.push(yield* decodeDispense(wire))
      }
      if (dropped > 0) {
        yield* Effect.logInfo(
          `PrescriptionEntity: dropped ${dropped} of ${rawDispenses.length} dispense entries with no dispenseId (or undecodable)`
        )
      }

      return [patient, request, ...dispenses]
    }),
})

export { PrescriptionEntity, SourcePrescription, SourceDispense }
