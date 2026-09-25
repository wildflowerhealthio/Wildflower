import { Array as Arr, Effect, Option, pipe, Schema, String as Str } from 'effect'
import { MedicationDispense } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind, extractJson, recognizePortal } from 'http-extraction-fundamentals'

import { decodesAsDateTime } from '../dates.ts'
import {
  ShoppersIdentifierSystem,
  shoppersStoreDisplay,
  shoppersStoreLocatorUrl,
} from '../shoppers.ts'
import { SHOPPERS_DRUGMART_SYSTEM } from '../source-system.ts'
import { medicationWire } from './medication-wire.ts'

/** The dispensing store as a history entry carries it (all parts optional). */
const SourceStore = Schema.Struct({
  // Lenient on string vs number — the portal's typing of the store id is unconfirmed.
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  storeName: Schema.optional(Schema.String),
})

/**
 * One dispense record in the history payload's flat `dispenses` array.
 * `dispenseId` keys the emitted resource, `prescriptionId` links it to its request;
 * both optional so a malformed entry drops-and-counts. `din` is **per-dispense**
 * (differs across fills).
 * */
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
 * The `authorizingPrescription` wire linking a dispense to its request: a
 * relative `MedicationRequest/<prescriptionId>` reference carrying
 * `prescriptionNumber` as the reference's own `identifier`. `undefined` when
 * neither is present.
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
 * The `location` wire: a `Reference` to the public store-locator URL for the
 * store id (absolute, so adoption leaves it untouched), with the store name as
 * `display`, else one made from the store number. `undefined` when no store id
 * is present.
 */
const locationWire = (
  store: typeof SourceStore.Type | undefined
): Record<string, unknown> | undefined => {
  if (store?.id == null) return undefined
  const storeId = String(store.id)
  if (storeId.length === 0) return undefined
  return {
    reference: shoppersStoreLocatorUrl(storeId),
    display: pipe(
      Option.fromNullable(store.storeName),
      Option.filter(Str.isNonEmpty),
      Option.getOrElse(() => shoppersStoreDisplay(storeId))
    ),
  }
}

/**
 * Build the R4 `MedicationDispense` **wire** for one history entry; `undefined`
 * when it has no `dispenseId` (so it drops-and-counts). `status` is a flat
 * `'completed'` and there is no `subject` — the payload carries no `patientId`.
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
 * One raw history entry as its `MedicationDispense` wire — `None` when it does
 * not decode as a {@link SourceHistoryDispense} or has no `dispenseId`, so the
 * caller can count it as dropped.
 */
const dispenseWireFrom = (raw: unknown): Option.Option<Record<string, unknown>> =>
  pipe(
    decodeSourceHistoryDispense(raw),
    Option.flatMap((dispense) => Option.fromNullable(dispenseWire(dispense)))
  )

/**
 * The exact prescription-history XHR URL, anchored and pinned to host + `v1` +
 * full path; the required `?…customerId=` query matches the API XHR but not the
 * user-facing page. Disjoint from the sibling kinds.
 */
const historyUrl =
  /^https:\/\/mypharmacy\.shoppersdrugmart\.ca\/api\/v1\/prescription-history\?(?:[^#]*&)?customerId=/

/**
 * Entity for the Shoppers prescription-history XHR: one payload carrying **every**
 * dispense across all prescriptions. Each entry synthesizes one
 * **`MedicationDispense`** (no Patient, no MedicationRequest), linked to its
 * request via `authorizingPrescription`. A prescription's latest fill also
 * appears in the status feed under the same `dispenseId` → same adopted id → an
 * idempotent upsert; neither version subsumes the other and write order is not
 * guaranteed, so last-write-wins loses whichever fields the winner omits. A
 * dispense with no `dispenseId` drops-and-counts via `Effect.logInfo`.
 */
const PrescriptionHistoryResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> =
  HttpResponseKind.make({
    name: 'PrescriptionHistoryResponseKind',
    tryRecognize: recognizePortal(historyUrl, SHOPPERS_DRUGMART_SYSTEM),
    parse: (response) =>
      Effect.gen(function* () {
        const { dispenses: raw } = yield* decodeHistory(extractJson(response.text()))

        const rawDispenses = raw ?? []
        const dispenseWires = Arr.filterMap(rawDispenses, dispenseWireFrom)
        const dropped = rawDispenses.length - dispenseWires.length
        const dispenses = yield* Effect.forEach(dispenseWires, (wire) => decodeDispense(wire))
        if (dropped > 0) {
          yield* Effect.logInfo(
            `PrescriptionHistoryResponseKind: dropped ${dropped} of ${rawDispenses.length} dispense entries with no dispenseId (or undecodable)`
          )
        }

        return dispenses
      }),
  })

export { PrescriptionHistoryResponseKind, HistoryPayload, SourceHistoryDispense }
