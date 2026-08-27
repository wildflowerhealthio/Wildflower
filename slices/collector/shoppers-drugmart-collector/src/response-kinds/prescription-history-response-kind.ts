import { Effect, Option, Schema } from 'effect'
import { MedicationDispense } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind, Specificity } from 'http-extraction-fundamentals'

import { decodesAsDateTime } from '../dates.ts'
import { extractJson } from '../extract-json.ts'
import { ShoppersIdentifierSystem, shoppersStoreLocatorUrl } from '../shoppers.ts'
import { SHOPPERS_DRUGMART_SYSTEM } from '../source-system.ts'
import { medicationWire } from './medication-wire.ts'

/** The dispensing store as a history entry carries it (all parts optional). */
const SourceStore = Schema.Struct({
  // Lenient on string vs number: the portal's typing of the store id is
  // unconfirmed, and it only ever rides the store-locator URL as a string.
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  storeName: Schema.optional(Schema.String),
})

/**
 * One dispense record inside a `…/api/<seg>/prescription-history?customerId=…`
 * payload's flat `dispenses` array. `dispenseId` keys the emitted resource and
 * `prescriptionId` links it back to its `MedicationRequest`; both are optional
 * here so a malformed entry is dropped-and-counted at {@link dispenseWire}
 * rather than failing the whole payload's decode. `din` is **per-dispense** — it
 * differs across fills of one prescription (a brand ↔ generic swap).
 */
const SourceHistoryDispense = Schema.Struct({
  prescriptionId: Schema.optional(Schema.String),
  dispenseId: Schema.optional(Schema.String),
  prescriptionNumber: Schema.optional(Schema.Number),
  dispenseDate: Schema.optional(Schema.String),
  chemicalName: Schema.optional(Schema.String),
  brandName: Schema.optional(Schema.String),
  quantityDispensed: Schema.optional(Schema.Number),
  din: Schema.optional(Schema.String),
  store: Schema.optional(SourceStore),
})

type SourceHistoryDispense = typeof SourceHistoryDispense.Type

/** `{ "dispenses": [ … ] }` — the whole history payload. */
const HistoryPayload = Schema.Struct({
  dispenses: Schema.optional(Schema.Array(Schema.Unknown)),
})

const decodeHistory = Schema.decode(Schema.parseJson(HistoryPayload))
const decodeSourceHistoryDispense = Schema.decodeUnknownOption(SourceHistoryDispense)
const decodeDispense = Schema.decodeUnknown(MedicationDispense.Schema)

/**
 * The `authorizingPrescription` wire linking a history dispense back to its
 * request: a relative `MedicationRequest/<prescriptionId>` reference (re-keyed by
 * adoption onto the request {@link !PrescriptionResponseKind} wrote), carrying the
 * human-facing `prescriptionNumber` as the reference's own `identifier` (that
 * number names the prescription, not the dispense, so it belongs here rather than
 * on the dispense's `identifier`). `undefined` when neither is present.
 */
const authorizingPrescriptionWire = (
  dispense: SourceHistoryDispense
): ReadonlyArray<Record<string, unknown>> | undefined => {
  const wire: Record<string, unknown> = {}
  if (dispense.prescriptionId != null) {
    wire['reference'] = `MedicationRequest/${dispense.prescriptionId}`
  }
  if (dispense.prescriptionNumber != null) {
    wire['identifier'] = {
      system: ShoppersIdentifierSystem.PrescriptionNumber,
      value: String(dispense.prescriptionNumber),
    }
  }
  return Object.keys(wire).length > 0 ? [wire] : undefined
}

/**
 * The `location` wire: a `Reference` whose `reference` is the public
 * store-locator URL for the dispensing store's id (absolute, so adoption leaves
 * it untouched — the same convention as the request's `supportingInformation`),
 * with the store name as `display`. `undefined` when no (non-empty) store id is
 * present.
 */
const locationWire = (
  store: typeof SourceStore.Type | undefined
): Record<string, unknown> | undefined => {
  if (store?.id == null) return undefined
  const storeId = String(store.id)
  if (storeId.length === 0) return undefined
  return {
    reference: shoppersStoreLocatorUrl(storeId),
    ...(store.storeName != null ? { display: store.storeName } : {}),
  }
}

/**
 * Build the FHIR R4 `MedicationDispense` **wire** for one history entry. Returns
 * `undefined` when the entry has no `dispenseId` (no logical id to write under),
 * so it is dropped-and-counted rather than silently skipped at the persist sink.
 *
 * `status` is a flat `'completed'`: history entries are completed fills and the
 * payload carries no status field to say otherwise. There is **no `subject`** —
 * the history payload carries no `patientId`, and `MedicationDispense.subject` is
 * 0..1 in R4, so the slot is simply omitted.
 */
const dispenseWire = (dispense: SourceHistoryDispense): Record<string, unknown> | undefined => {
  if (dispense.dispenseId == null) return undefined
  const wire: Record<string, unknown> = {
    resourceType: 'MedicationDispense',
    id: dispense.dispenseId,
    identifier: [{ system: ShoppersIdentifierSystem.DispenseId, value: dispense.dispenseId }],
    status: 'completed',
  }
  const medication = medicationWire(dispense)
  if (medication != null) wire['medicationCodeableConcept'] = medication
  const authorizing = authorizingPrescriptionWire(dispense)
  if (authorizing != null) wire['authorizingPrescription'] = authorizing
  if (dispense.quantityDispensed != null && Number.isFinite(dispense.quantityDispensed)) {
    wire['quantity'] = { value: dispense.quantityDispensed }
  }
  if (decodesAsDateTime(dispense.dispenseDate)) wire['whenHandedOver'] = dispense.dispenseDate
  const location = locationWire(dispense.store)
  if (location != null) wire['location'] = location
  return wire
}

/**
 * `…://host/api/<seg>/prescription-history?customerId=…`. Requires the
 * `customerId` query (a hand-rolled `mustHaveQuery`) so it matches the API XHR
 * but **not** the user-facing page `…/en/prescription-history` (which the SPA
 * navigates to and which carries no query). Version-agnostic (`/api/[^/]+/…`):
 * the capture shows `/api/p1/…` while the endpoint is documented as `/api/v1/…`.
 * Disjoint from {@link !CustomerResponseKind} and {@link !PrescriptionResponseKind} by
 * construction — different path segments — so entity order is not load-bearing.
 */
const historyUrl = /:\/\/[^/]+\/api\/[^/]+\/prescription-history\/?\?(?:[^#]*&)?customerId=/

/**
 * Entity for the Shoppers prescription-history XHR: the
 * `…/api/<seg>/prescription-history?customerId=…` payload the
 * prescription-history page fires once, carrying **every** dispense across all
 * prescriptions (the status endpoint carries at most the latest fill per
 * prescription). Each entry synthesizes one **`MedicationDispense`** — no
 * Patient, no MedicationRequest — linked to its request via
 * `authorizingPrescription`.
 *
 * The latest fill of a prescription appears in both this feed and the
 * status feed; same `dispenseId` → same adopted id → an idempotent upsert.
 * Neither version subsumes the other — this one carries its own `din`,
 * quantity, date and dispensing store, while the status feed's carries the
 * `subject` the history payload has no `patientId` for — and write ordering
 * within a run is not guaranteed, so last-write-wins on the shared id loses
 * whichever fields the winning side omits. A dispense with no `dispenseId` is
 * dropped-and-counted via `Effect.logInfo`. {@link extractJson} normalizes the
 * body across raw-XHR intercepts and the mobile WebView's JSON-viewer wrap.
 */
const PrescriptionHistoryResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> =
  HttpResponseKind.make({
    name: 'PrescriptionHistoryResponseKind',
    // Mints the constant portal SID; no `baseUrl` — references are relative.
    tryRecognize: (url) =>
      historyUrl.test(url)
        ? Option.some({
            specificity: Specificity.PORTAL,
            source: { system: SHOPPERS_DRUGMART_SYSTEM },
          })
        : Option.none(),
    parse: (response) =>
      Effect.gen(function* () {
        const { dispenses: raw } = yield* decodeHistory(extractJson(response.text()))

        const rawDispenses = raw ?? []
        const dispenses: Array<typeof MedicationDispense.Schema.Type> = []
        let dropped = 0
        for (const entry of rawDispenses) {
          const decoded = decodeSourceHistoryDispense(entry)
          const wire = Option.isSome(decoded) ? dispenseWire(decoded.value) : undefined
          if (wire === undefined) {
            dropped += 1
            continue
          }
          dispenses.push(yield* decodeDispense(wire))
        }
        if (dropped > 0) {
          yield* Effect.logInfo(
            `PrescriptionHistoryResponseKind: dropped ${dropped} of ${rawDispenses.length} dispense entries with no dispenseId (or undecodable)`
          )
        }

        return dispenses
      }),
  })

export { PrescriptionHistoryResponseKind, HistoryPayload, SourceHistoryDispense }
