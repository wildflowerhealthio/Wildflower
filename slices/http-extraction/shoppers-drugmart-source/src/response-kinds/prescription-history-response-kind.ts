import {
  Array as Arr,
  Effect,
  Option,
  type ParseResult,
  pipe,
  RegExp as EffectRegExp,
  Schema,
  String as Str,
} from 'effect'
import { MedicationDispense } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind, extractJson, recognizePortal } from 'http-extraction-fundamentals'

import { decodesAsDateTime } from '../dates.ts'
import { SHOPPERS_API_BASE_URL } from '../portal-url.ts'
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
const decodeCustomerId = Schema.decodeUnknown(Schema.NonEmptyString)
const decodeSourceHistoryDispense = Schema.decodeUnknownOption(SourceHistoryDispense)
const decodeDispense = Schema.decodeUnknown(MedicationDispense.Schema)

/**
 * The account a history XHR is for: its `customerId` query parameter, which
 * is the account's `pcid`. A `ParseError` when the URL carries none.
 */
const customerIdOf = (url: string): Effect.Effect<string, ParseResult.ParseError> =>
  decodeCustomerId(URL.parse(url)?.searchParams.get('customerId'))

/**
 * The `subject` wire: the **account** `Patient`, `Patient/<pcid>`, which is
 * the id `CustomerResponseKind` keys the account under, so adoption lands both
 * on one local id. The feed names no managed person, so the account is the
 * most it can say. The `pcid` rides as the reference's own `identifier`, under
 * `ShoppersIdentifierSystem.PcId`, so the reference says it names an account.
 */
const accountReferenceWire = (customerId: string): Record<string, unknown> => ({
  reference: `Patient/${customerId}`,
  identifier: { system: ShoppersIdentifierSystem.PcId, value: customerId },
})

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
 * `'completed'`, and the `subject` is the account the history is for — the
 * payload carries no `patientId`.
 */
const dispenseWire = (
  dispense: SourceHistoryDispense,
  customerId: string
): Record<string, unknown> | undefined => {
  if (dispense.dispenseId == null) return undefined
  const wire: Record<string, unknown> = {
    resourceType: 'MedicationDispense',
    id: dispense.dispenseId,
    identifier: [{ system: ShoppersIdentifierSystem.DispenseId, value: dispense.dispenseId }],
    status: 'completed',
    subject: accountReferenceWire(customerId),
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
const dispenseWireFrom =
  (customerId: string) =>
  (raw: unknown): Option.Option<Record<string, unknown>> =>
    pipe(
      decodeSourceHistoryDispense(raw),
      Option.flatMap((dispense) => Option.fromNullable(dispenseWire(dispense, customerId)))
    )

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
 * request via `authorizingPrescription`. Its `subject` is the **account**
 * `Patient` named by the URL's `customerId`, not the managed person the fill
 * was for: the payload does not say which person that is. A prescription's
 * latest fill also appears in the status feed under the same `dispenseId`,
 * which names the person; the source's `mergeResources` combines the two
 * copies wherever one extraction holds both (`merge-resources.ts`). A dispense with no `dispenseId`
 * drops-and-counts via `Effect.logInfo`; a URL with no `customerId` fails the
 * parse.
 */
const PrescriptionHistoryResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> =
  HttpResponseKind.make({
    name: 'PrescriptionHistoryResponseKind',
    tryRecognize: recognizePortal(historyUrl, SHOPPERS_DRUGMART_SYSTEM),
    parse: (response) =>
      Effect.gen(function* () {
        const customerId = yield* customerIdOf(response.url)
        const { dispenses: raw } = yield* decodeHistory(extractJson(response.text()))

        const rawDispenses = raw ?? []
        const dispenseWires = Arr.filterMap(rawDispenses, dispenseWireFrom(customerId))
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
