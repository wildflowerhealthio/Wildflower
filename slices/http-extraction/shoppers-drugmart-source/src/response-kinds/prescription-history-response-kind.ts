import { MedicationDispense } from '@wildflowerhealthio/fhir-r4/resources'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import {
  HttpResponseKind,
  extractJson,
  recognizePortal,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import {
  Array as Arr,
  Effect,
  Option,
  pipe,
  RegExp as EffectRegExp,
  Schema,
  String as Str,
} from 'effect'

import { decodesAsDateTime } from '../dates.ts'
import { DecodableEntries } from '../lenient-schemas.ts'
import { portalGetMatcher, SHOPPERS_API_BASE_URL } from '../portal-url.ts'
import {
  ShoppersIdentifierSystem,
  shoppersStoreDisplay,
  shoppersStoreLocatorUrl,
} from '../shoppers.ts'
import { SHOPPERS_DRUGMART_SYSTEM } from '../source-system.ts'
import { medicationWire } from './medication-wire.ts'

/** The dispensing store as a history entry carries it (all parts optional; `null` reads as absent). */
const SourceStore = Schema.Struct({
  // Lenient on string vs number — the portal's typing of the store id is unconfirmed.
  id: Schema.optionalWith(Schema.Union(Schema.String, Schema.Number), { nullable: true }),
  storeName: Schema.optionalWith(Schema.String, { nullable: true }),
})

/**
 * One dispense record in the history payload's flat `dispenses` array.
 * `dispenseId` keys the emitted resource, `prescriptionId` links it to its request;
 * both optional: an entry with no `dispenseId` drops-and-counts, and one with no
 * `prescriptionId` links to no request. Every field reads `null` as absent.
 * `din` is **per-dispense** (differs across fills).
 * */
const SourceHistoryDispense = Schema.Struct({
  prescriptionId: Schema.optionalWith(Schema.String, { nullable: true }),
  dispenseId: Schema.optionalWith(Schema.String, { nullable: true }),
  prescriptionNumber: Schema.optionalWith(Schema.Number, { nullable: true }),
  dispenseDate: Schema.optionalWith(Schema.String, { nullable: true }),
  chemicalName: Schema.optionalWith(Schema.String, { nullable: true }),
  brandName: Schema.optionalWith(Schema.String, { nullable: true }),
  quantityDispensed: Schema.optionalWith(Schema.Number, { nullable: true }),
  din: Schema.optionalWith(Schema.String, { nullable: true }),
  store: Schema.optionalWith(SourceStore, { nullable: true }),
})

type SourceHistoryDispense = typeof SourceHistoryDispense.Type

/**
 * `{ "dispenses": [ … ] }` — the whole history payload. `dispenses` decodes
 * entry by entry ({@link DecodableEntries}): an entry that is not a
 * {@link SourceHistoryDispense} is counted, not decoded, and never fails the
 * payload. A `null` list reads as absent.
 */
const HistoryPayload = Schema.Struct({
  dispenses: Schema.optionalWith(DecodableEntries(SourceHistoryDispense), { nullable: true }),
})

const decodeHistory = Schema.decode(Schema.parseJson(HistoryPayload))
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
 * `'completed'`, and there is no `subject`: the payload carries no
 * `patientId`.
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
 * The exact prescription-history XHR URL (`prescriptionHistoryUrlOf`), anchored
 * and pinned to {@link SHOPPERS_API_BASE_URL} + full path; the required
 * `?…customerId=` query matches the API XHR but not the user-facing page.
 * Disjoint from the sibling kinds.
 */
const historyUrl = new RegExp(
  `^${EffectRegExp.escape(SHOPPERS_API_BASE_URL)}/prescription-history\\?(?:[^#]*&)?customerId=`
)

/**
 * Entity for the Shoppers prescription-history XHR: one payload carrying **every**
 * dispense across all prescriptions of an account. Each entry synthesizes one
 * **`MedicationDispense`** (no Patient, no MedicationRequest), linked to its
 * request via `authorizingPrescription`, with **no `subject`**: the payload
 * does not say which managed person the fill was for. A prescription's latest
 * fill also appears in the status feed under the same `dispenseId`, which
 * names the person; the source's `mergeResources` combines the two copies
 * wherever one extraction holds both (`merge-resources.ts`), and its
 * `completeFromExtraction` files every fill on the extraction's one Patient,
 * when it holds exactly one (`history-fill-subjects.ts`). The URL's `customerId` only recognizes the
 * XHR. A dispense entry that does not decode as a {@link SourceHistoryDispense}
 * (a `quantityDispensed` sent as a string, say, or an entry that is not an
 * object), and one with no `dispenseId` (absent or `null`), drops-and-counts
 * via `Effect.logInfo`; its siblings are still emitted.
 */
const PrescriptionHistoryResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> =
  HttpResponseKind.make({
    name: 'PrescriptionHistoryResponseKind',
    tryRecognize: recognizePortal(portalGetMatcher(historyUrl), SHOPPERS_DRUGMART_SYSTEM),
    parse: (response) =>
      Effect.gen(function* () {
        const { dispenses: entries } = yield* decodeHistory(extractJson(response.text()))
        const { decoded, undecodable } = entries ?? { decoded: [], undecodable: 0 }

        const dispenseWires = Arr.filterMap(decoded, (dispense) =>
          Option.fromNullable(dispenseWire(dispense))
        )
        const withoutId = decoded.length - dispenseWires.length
        const dispenses = yield* Effect.forEach(dispenseWires, (wire) => decodeDispense(wire))
        if (undecodable + withoutId > 0) {
          yield* Effect.logInfo(
            `PrescriptionHistoryResponseKind: dropped ${undecodable + withoutId} of ${undecodable + decoded.length} dispense entries (${undecodable} undecodable, ${withoutId} with no dispenseId)`
          )
        }

        return dispenses
      }),
  })

export { PrescriptionHistoryResponseKind, HistoryPayload, SourceHistoryDispense }
