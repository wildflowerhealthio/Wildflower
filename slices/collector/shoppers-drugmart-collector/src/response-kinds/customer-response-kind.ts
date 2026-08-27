import { Effect, Option, Schema } from 'effect'
import { Patient } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind, Specificity } from 'http-extraction-fundamentals'

import { extractJson } from '../extract-json.ts'
import { ShoppersIdentifierSystem } from '../shoppers.ts'
import { SHOPPERS_DRUGMART_SYSTEM } from '../source-system.ts'

/** A postal address as the customers payload carries it (all parts optional). */
const SourceAddress = Schema.Struct({
  line1: Schema.optional(Schema.String),
  line2: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  province: Schema.optional(Schema.String),
  postalCode: Schema.optional(Schema.String),
})

type SourceAddress = typeof SourceAddress.Type

/**
 * One managed person under an account (`customer.patients[]`). `id` is required
 * — it is the id `MedicationRequest.subject` / `MedicationDispense.subject`
 * resolve to and the key of the demographic Patient this becomes — everything
 * else is optional and lenient.
 */
const SourcePatient = Schema.Struct({
  id: Schema.String,
  firstName: Schema.optional(Schema.String),
  lastName: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  phoneNumber: Schema.optional(Schema.String),
  address: Schema.optional(SourceAddress),
})

type SourcePatient = typeof SourcePatient.Type

/**
 * Just-enough schema for one `…/api/<seg>/customers/:uuid?expand=…` payload — a
 * bespoke portal JSON shape, **not FHIR**. Only `customer.pcid` (the account id,
 * `== customer.id == the customerId` query param) is required; `patients` is
 * decoded as an array of `Unknown` and each entry re-decoded per-entry so one
 * malformed patient is dropped-and-counted rather than failing the whole
 * account. Everything else is optional and lenient (unknown fields drop on
 * decode).
 */
const CustomerPayload = Schema.Struct({
  customer: Schema.Struct({
    pcid: Schema.String,
    firstName: Schema.optional(Schema.String),
    lastName: Schema.optional(Schema.String),
    email: Schema.optional(Schema.String),
    phoneNumber: Schema.optional(Schema.String),
    address: Schema.optional(SourceAddress),
    patients: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
})

type CustomerPayload = typeof CustomerPayload.Type

const decodeCustomer = Schema.decode(Schema.parseJson(CustomerPayload))
const decodeSourcePatient = Schema.decodeUnknownOption(SourcePatient)
const decodePatient = Schema.decodeUnknown(Patient.Schema)

/**
 * The R4 `HumanName[]` wire (a single name) for a family/given pair, falling
 * back to a `text`-only name when only a combined display name is present.
 * Returns `undefined` when the source names nothing, so the caller omits the
 * `name` slot entirely.
 */
const nameWire = (
  firstName: string | undefined,
  lastName: string | undefined,
  displayName?: string
): ReadonlyArray<Record<string, unknown>> | undefined => {
  if (firstName != null || lastName != null) {
    return [
      {
        ...(lastName != null ? { family: lastName } : {}),
        ...(firstName != null ? { given: [firstName] } : {}),
        ...(displayName != null ? { text: displayName } : {}),
      },
    ]
  }
  if (displayName != null) return [{ text: displayName }]
  return undefined
}

/**
 * The R4 `Address[]` wire (a single address) for a source address, emitting only
 * the parts present. Returns `undefined` when the source carries no address
 * parts at all, so the caller omits the slot.
 */
const addressWire = (
  address: SourceAddress | undefined
): ReadonlyArray<Record<string, unknown>> | undefined => {
  if (address == null) return undefined
  const line = [address.line1, address.line2].filter((l): l is string => l != null && l.length > 0)
  const wire: Record<string, unknown> = {}
  if (line.length > 0) wire['line'] = line
  if (address.city != null) wire['city'] = address.city
  if (address.province != null) wire['state'] = address.province
  if (address.postalCode != null) wire['postalCode'] = address.postalCode
  return Object.keys(wire).length > 0 ? [wire] : undefined
}

/** A `{ system, value }` telecom entry list, omitting the slot when empty. */
const telecomWire = (
  email: string | undefined,
  phone: string | undefined
): ReadonlyArray<Record<string, unknown>> | undefined => {
  const telecom: Array<Record<string, unknown>> = []
  if (email != null) telecom.push({ system: 'email', value: email })
  if (phone != null) telecom.push({ system: 'phone', value: phone })
  return telecom.length > 0 ? telecom : undefined
}

/**
 * The demographic `Patient` **wire** for one managed person, keyed by its own
 * `id` — the record `MedicationRequest.subject` / `MedicationDispense.subject`
 * resolve to. Carries name (family/given, with the portal's `displayName` as
 * `text`), a phone telecom, and address when present, with the source
 * `patientId` recorded as `identifier[0]`.
 */
const patientWire = (patient: SourcePatient): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'Patient',
    id: patient.id,
    identifier: [{ system: ShoppersIdentifierSystem.PatientId, value: patient.id }],
  }
  const name = nameWire(patient.firstName, patient.lastName, patient.displayName)
  if (name != null) wire['name'] = name
  const telecom = telecomWire(undefined, patient.phoneNumber)
  if (telecom != null) wire['telecom'] = telecom
  const address = addressWire(patient.address)
  if (address != null) wire['address'] = address
  return wire
}

/**
 * The account `Patient` **wire**, keyed by `customer.pcid`, carrying the
 * account-level name, email, phone, and address. It carries a `link.seealso` to
 * each managed person's demographic Patient (`patientIds`) — after
 * `adoptUnderRecognizedRoot` rewrites those relative references, the account↔person
 * join the customers payload asserts is finally materialized in the store.
 */
const accountPatientWire = (
  customer: CustomerPayload['customer'],
  patientIds: ReadonlyArray<string>
): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'Patient',
    id: customer.pcid,
    identifier: [{ system: ShoppersIdentifierSystem.PcId, value: customer.pcid }],
  }
  const name = nameWire(customer.firstName, customer.lastName)
  if (name != null) wire['name'] = name
  const telecom = telecomWire(customer.email, customer.phoneNumber)
  if (telecom != null) wire['telecom'] = telecom
  const address = addressWire(customer.address)
  if (address != null) wire['address'] = address
  if (patientIds.length > 0) {
    wire['link'] = patientIds.map((id) => ({
      other: { reference: `Patient/${id}` },
      type: 'seealso',
    }))
  }
  return wire
}

/**
 * `…://host/api/<seg>/customers/<uuid>` with an optional query. Anchors the uuid
 * as the **final** path segment (`[^/?#]+` then `\/?(?:[?#]|$)`) so it matches
 * `…/customers/<uuid>` and `…/customers/<uuid>?expand=…` but **not**
 * `…/customers/<uuid>/toasts?source=LOGIN` (or any other sub-path). Disjoint
 * from {@link !PrescriptionResponseKind} (`/prescriptions/:uuid/prescription-status`)
 * and {@link !PrescriptionHistoryResponseKind} (`/prescription-history?customerId=…`)
 * by construction — different final segments — so entity order is not
 * load-bearing. Version-agnostic (`/api/[^/]+/…`): the capture shows `/api/p1/…`
 * while the endpoint is documented as `/api/v1/…`.
 */
const customerUrl = /:\/\/[^/]+\/api\/[^/]+\/customers\/[^/?#]+\/?(?:[?#]|$)/

/**
 * Entity for the Shoppers customers XHR: the
 * `…/api/<seg>/customers/:uuid?expand=…` payload the health dashboard and the
 * prescription-history page fire. Each response is one bespoke JSON object (not
 * FHIR) carrying the account and the people it manages, synthesized here into:
 *
 * - one **demographic `Patient` per `customer.patients[]` entry**, keyed by its
 *   `id` (the id the prescription/history `subject` references resolve to); and
 * - one **account `Patient`** keyed by `customer.pcid`, `link.seealso`-ing each
 *   demographic Patient so the account↔person join the payload asserts survives
 *   into the store.
 *
 * This entity — not {@link !PrescriptionResponseKind} — owns the subject Patient
 * records. A run where this customers XHR fails therefore leaves the
 * prescriptions' `subject` references dangling; the store tolerates that
 * (references are not FK-enforced) and the same run always visits a page that
 * fires this XHR, so the dangle is a partial-run edge case, not the norm. A
 * patient entry that fails to decode (no `id`) is dropped-and-counted via
 * `Effect.logInfo`. {@link extractJson} normalizes the body across raw-XHR
 * intercepts and the mobile WebView's JSON-viewer wrap.
 */
const CustomerResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> = HttpResponseKind.make(
  {
    name: 'CustomerResponseKind',
    // URL-gated by this kind's own pattern; on a match it mints the portal
    // source (`system` only — the collector writes relative references, so no
    // `baseUrl`).
    tryRecognize: (url) =>
      customerUrl.test(url)
        ? Option.some({
            specificity: Specificity.PORTAL,
            source: { system: SHOPPERS_DRUGMART_SYSTEM },
          })
        : Option.none(),
    parse: (response) =>
      Effect.gen(function* () {
        const { customer } = yield* decodeCustomer(extractJson(response.text()))

        const rawPatients = customer.patients ?? []
        const patients: Array<typeof Patient.Schema.Type> = []
        const patientIds: Array<string> = []
        let dropped = 0
        for (const raw of rawPatients) {
          const decoded = decodeSourcePatient(raw)
          if (Option.isNone(decoded)) {
            dropped += 1
            continue
          }
          patientIds.push(decoded.value.id)
          patients.push(yield* decodePatient(patientWire(decoded.value)))
        }
        if (dropped > 0) {
          yield* Effect.logInfo(
            `CustomerResponseKind: dropped ${dropped} of ${rawPatients.length} patient entries with no id (or undecodable)`
          )
        }

        const account = yield* decodePatient(accountPatientWire(customer, patientIds))
        return [...patients, account]
      }),
  }
)

export { CustomerResponseKind, CustomerPayload, SourcePatient }
