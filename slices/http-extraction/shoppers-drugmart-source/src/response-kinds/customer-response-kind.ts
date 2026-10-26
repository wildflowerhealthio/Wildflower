import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import {
  HttpResponseKind,
  extractJson,
  recognizePortal,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { Array as Arr, Effect, type ParseResult, RegExp as EffectRegExp, Schema } from 'effect'

import { DecodableEntries, MalformedAsAbsent } from '../lenient-schemas.ts'
import { portalGetMatcher, SHOPPERS_API_BASE_URL } from '../portal-url.ts'
import { ShoppersIdentifierSystem } from '../shoppers.ts'
import { SHOPPERS_DRUGMART_SYSTEM } from '../source-system.ts'

/**
 * A postal address as the customers payload carries it: every part optional,
 * and one that is `null` or malformed reads as absent ({@link MalformedAsAbsent}).
 */
const SourceAddress = Schema.Struct({
  line1: MalformedAsAbsent(Schema.String),
  line2: MalformedAsAbsent(Schema.String),
  city: MalformedAsAbsent(Schema.String),
  province: MalformedAsAbsent(Schema.String),
  postalCode: MalformedAsAbsent(Schema.String),
})

type SourceAddress = typeof SourceAddress.Type

/**
 * One managed person under an account (`customer.patients[]`). `id` is required
 * — the key of the demographic Patient this becomes, and the id `subject`
 * references resolve to. Every other field is optional, and one that is `null`
 * or malformed (a `phoneNumber` sent as a number, say) reads as absent
 * ({@link MalformedAsAbsent}), so a person with an `id` is always kept.
 */
const SourcePatient = Schema.Struct({
  id: Schema.String,
  firstName: MalformedAsAbsent(Schema.String),
  lastName: MalformedAsAbsent(Schema.String),
  displayName: MalformedAsAbsent(Schema.String),
  phoneNumber: MalformedAsAbsent(Schema.String),
  address: MalformedAsAbsent(SourceAddress),
})

type SourcePatient = typeof SourcePatient.Type

/**
 * Just-enough schema for one bespoke (non-FHIR) customers payload: the people
 * the account manages, and the account's contact email and phone. The
 * account's other fields (its `pcid`, name and address) are not read: an
 * account is not a person, and every person it manages, the holder included,
 * is one of `patients`. The email and phone read as absent when `null` or
 * malformed, as {@link SourcePatient}'s fields do. `patients` decodes entry by
 * entry ({@link DecodableEntries}): an entry that is not a
 * {@link SourcePatient} (no `id`, an `id` that is not a string, or not an
 * object at all) is counted, not decoded, and never fails the payload.
 */
const CustomerPayload = Schema.Struct({
  customer: Schema.Struct({
    email: MalformedAsAbsent(Schema.String),
    phoneNumber: MalformedAsAbsent(Schema.String),
    patients: Schema.optionalWith(DecodableEntries(SourcePatient), { nullable: true }),
  }),
})

type CustomerPayload = typeof CustomerPayload.Type

const decodeCustomer = Schema.decode(Schema.parseJson(CustomerPayload))
const decodePatient = Schema.decodeUnknown(Patient.Schema)

/**
 * The R4 `HumanName[]` wire for a person's family/given pair (or a `text`-only
 * name from their combined display name); `undefined` when the source names
 * nothing.
 */
const nameWire = ({
  firstName,
  lastName,
  displayName,
}: SourcePatient): ReadonlyArray<Record<string, unknown>> | undefined => {
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

/** Contact details as the customers payload carries them, a person's or the account's. */
interface SourceContact {
  readonly email?: string | undefined
  readonly phoneNumber?: string | undefined
}

/**
 * The `telecom` wire for `contacts`, in order, each `system` + `value` once;
 * `undefined` when there are none.
 */
const telecomWire = (
  contacts: readonly SourceContact[]
): ReadonlyArray<Record<string, unknown>> | undefined => {
  const telecom = Arr.dedupeWith(
    contacts.flatMap(({ email, phoneNumber }) => [
      ...(email == null ? [] : [{ system: 'email', value: email }]),
      ...(phoneNumber == null ? [] : [{ system: 'phone', value: phoneNumber }]),
    ]),
    (left, right) => left.system === right.system && left.value === right.value
  )
  return telecom.length > 0 ? telecom : undefined
}

/**
 * The demographic `Patient` **wire** for one managed person, keyed by its own
 * `id` (the record `subject` references resolve to), with `patientId` as
 * `identifier[0]`, and reached at their own phone and then at each of
 * `alsoReachedAt`.
 */
const patientWire = (
  patient: SourcePatient,
  alsoReachedAt: readonly SourceContact[]
): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'Patient',
    id: patient.id,
    identifier: [{ system: ShoppersIdentifierSystem.PatientId, value: patient.id }],
  }
  const name = nameWire(patient)
  if (name != null) wire['name'] = name
  const telecom = telecomWire([{ phoneNumber: patient.phoneNumber }, ...alsoReachedAt])
  if (telecom != null) wire['telecom'] = telecom
  const address = addressWire(patient.address)
  if (address != null) wire['address'] = address
  return wire
}

/** The demographic `Patient` for one managed person, also reached at each of `alsoReachedAt`. */
const demographicPatientOf = (
  patient: SourcePatient,
  alsoReachedAt: readonly SourceContact[]
): Effect.Effect<typeof Patient.Schema.Type, ParseResult.ParseError> =>
  decodePatient(patientWire(patient, alsoReachedAt))

/**
 * The exact customers XHR URL (`customerUrlOf`), anchored and pinned to
 * {@link SHOPPERS_API_BASE_URL} + full path with an optional query;
 * `[^/?#]+(?:\?|$)` keeps the uuid a single segment (so `…/pcid/<uuid>/toasts`
 * is rejected). Disjoint from the sibling kinds.
 */
const customerUrl = new RegExp(
  `^${EffectRegExp.escape(SHOPPERS_API_BASE_URL)}/customers/pcid/[^/?#]+(?:\\?|$)`
)

/**
 * Entity for the Shoppers customers XHR: one bespoke JSON object carrying the
 * account and the people it manages, synthesized into a demographic `Patient`
 * per `customer.patients[]` entry and nothing else: the account is not a
 * person, so it is no Patient. When `patients` lists exactly one person, the
 * account's email and phone are theirs too and join their `telecom`; with
 * several, nothing says whose they are, so they are dropped. This entity — not
 * {@link PrescriptionResponseKind} — owns the subject Patient records, so a run
 * where this XHR fails leaves those `subject` references dangling (tolerated;
 * not FK-enforced). A patient entry that does not decode as a
 * {@link SourcePatient} (one with no string `id`, or not an object)
 * drops-and-counts via `Effect.logInfo`; a malformed optional field only drops
 * that field.
 */
const CustomerResponseKind: HttpResponseKind.HttpResponseKind<FhirResource> = HttpResponseKind.make(
  {
    name: 'CustomerResponseKind',
    tryRecognize: recognizePortal(portalGetMatcher(customerUrl), SHOPPERS_DRUGMART_SYSTEM),
    parse: (response) =>
      Effect.gen(function* () {
        const { customer } = yield* decodeCustomer(extractJson(response.text()))

        const { decoded: sourcePatients, undecodable } = customer.patients ?? {
          decoded: [],
          undecodable: 0,
        }
        // The account's contact details are surely a person's only when it lists just them.
        const accountContacts: readonly SourceContact[] =
          sourcePatients.length === 1 && undecodable === 0 ? [customer] : []
        const patients = yield* Effect.forEach(sourcePatients, (patient) =>
          demographicPatientOf(patient, accountContacts)
        )
        if (undecodable > 0) {
          yield* Effect.logInfo(
            `CustomerResponseKind: dropped ${undecodable} of ${undecodable + sourcePatients.length} patient entries that do not decode (no string id, or not an object)`
          )
        }
        return patients
      }),
  }
)

export { CustomerResponseKind, CustomerPayload, SourcePatient }
