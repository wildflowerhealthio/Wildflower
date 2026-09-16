import { Effect, Option, Schema } from 'effect'
import { Patient } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { HttpResponseKind, extractJson, recognizePortal } from 'http-extraction-fundamentals'
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
 * — the key of the demographic Patient this becomes, and the id `subject`
 * references resolve to; the rest is optional and lenient.
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
 * Just-enough schema for one bespoke (non-FHIR) customers payload. Only
 * `customer.pcid` (the account id) is required; `patients` is decoded per-entry
 * so a malformed one drops-and-counts rather than failing the account.
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
 * The R4 `HumanName[]` wire for a family/given pair (or a `text`-only name from a
 * combined display name); `undefined` when the source names nothing.
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
 * The R4 `Address[]` wire for a source address, emitting only the parts present;
 * `undefined` when there are none.
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
 * `id` (the record `subject` references resolve to), with `patientId` as
 * `identifier[0]`.
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
 * The account `Patient` **wire**, keyed by `customer.pcid`, with a `link.seealso`
 * to each managed person's demographic Patient — adoption rewrites those
 * references, materializing the account↔person join in the store.
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
 * The exact customers XHR URL, anchored and pinned to host + `v1` + full path
 * with an optional query; `[^/?#]+(?:\?|$)` keeps the uuid a single segment (so
 * `…/pcid/<uuid>/toasts` is rejected). Disjoint from the sibling kinds.
 */
const customerUrl =
  /^https:\/\/mypharmacy\.shoppersdrugmart\.ca\/api\/v1\/customers\/pcid\/[^/?#]+(?:\?|$)/

/**
 * Entity for the Shoppers customers XHR: one bespoke JSON object carrying the
 * account and the people it manages, synthesized into a demographic `Patient`
 * per `customer.patients[]` entry plus an account `Patient` (`link.seealso`-ing
 * each). This entity — not {@link PrescriptionResponseKind} — owns the subject
 * Patient records, so a run where this XHR fails leaves those `subject`
 * references dangling (tolerated; not FK-enforced). A patient entry with no `id`
 * drops-and-counts via `Effect.logInfo`.
 */
const CustomerResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> = HttpResponseKind.make(
  {
    name: 'CustomerResponseKind',
    tryRecognize: recognizePortal(customerUrl, SHOPPERS_DRUGMART_SYSTEM),
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
