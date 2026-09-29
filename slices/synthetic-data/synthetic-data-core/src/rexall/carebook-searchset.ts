import { DateTime } from 'effect'
import {
  CarebookCodingSystem,
  CarebookExtension,
  CarebookIdentifierSystem,
  REXALL_SYSTEM_SOURCE,
  RequestTypeCode,
} from 'rexall-be-well-source'

import * as DrugProduct from '../drug-product.ts'
import * as Prescription from '../prescription.ts'
import * as Seeded from '../seeded.ts'
import { carebookTimestampOf, instantOn } from './carebook-time.ts'
import type { RexallAccount } from './rexall-account.ts'

/**
 * The prescriptions list's searchset — the body of the portal's
 * `…/fhir/stu3/pharmacy/Location?…&_query=lastActiveOnly…` XHR — built from a
 * story's prescriptions in the carebook STU3 dialect.
 *
 * @remarks
 * Modelled on `rexall-be-well-source/src/fixtures/prescriptions-searchset.json`
 * and the capture notes in that package's AGENTS.md: each prescription is one
 * `MedicationRequest` carrying its product as a contained `Medication` (DIN,
 * strength and description extensions), the sig in `note[0].text`, and the
 * repeats still available dual-written as `v1` / `v2` `modifierExtension`s; its
 * most recent fill is one `MedicationDispense` **sharing the request's `id`**
 * and identifiers. The list holds only those two resource types, as the capture
 * did. Every extension URL and coding system is `rexall-be-well-source`'s own
 * constant, so the dialect is spelled in one place.
 */

/** Where every `fullUrl` in the searchset is rooted. */
const STU3_BASE = 'https://rexall-prd-tunnel.letsbewell.ca/enduser/health/v1/fhir/stu3'

/** The dispensing pharmacy's zone, which the dialect records beside its `+00:00` timestamps. */
const PHARMACY_TIME_ZONE = 'America/Toronto'

interface Coding {
  readonly system: string
  readonly code: string
}

interface CodeableConcept {
  readonly coding: readonly Coding[]
  readonly text?: string
}

interface WireReference {
  readonly reference: string
  readonly identifier?: { readonly system?: string; readonly value: string }
  readonly display?: string
}

/** A carebook extension; the dialect uses these `value[x]` types. */
type WireExtension =
  | { readonly url: string; readonly valueString: string }
  | { readonly url: string; readonly valueBoolean: boolean }
  | { readonly url: string; readonly valueDateTime: string }
  | { readonly url: string; readonly valuePositiveInt: number }
  | { readonly url: string; readonly valueDecimal: number }
  | { readonly url: string; readonly valueReference: WireReference }
  | { readonly url: string; readonly valueCodeableConcept: CodeableConcept }

interface Meta {
  readonly versionId: string
  readonly lastUpdated: string
}

interface ContainedMedication {
  readonly resourceType: 'Medication'
  readonly id: string
  readonly meta: Meta
  readonly text: { readonly status: 'generated'; readonly div: string }
  readonly extension: readonly WireExtension[]
  readonly code: CodeableConcept
  readonly status: 'active'
  readonly manufacturer: { readonly display: string }
  readonly form: CodeableConcept
}

interface CarebookMedicationRequest {
  readonly resourceType: 'MedicationRequest'
  readonly id: string
  readonly meta: Meta
  readonly contained: readonly [ContainedMedication]
  readonly extension: readonly WireExtension[]
  readonly identifier: readonly Identifier[]
  readonly status: Prescription.Status
  readonly intent: 'order'
  readonly medicationCodeableConcept: CodeableConcept
  readonly subject: { readonly reference: string; readonly display: '' }
  readonly authoredOn: string
  readonly requester: { readonly agent: { readonly reference: string; readonly display: string } }
  readonly note: readonly [{ readonly text: string }]
  readonly dispenseRequest: {
    readonly modifierExtension: readonly WireExtension[]
    readonly numberOfRepeatsAllowed: number
    readonly quantity: { readonly value: number }
    readonly expectedSupplyDuration: { readonly value: number }
  }
}

interface CarebookMedicationDispense {
  readonly resourceType: 'MedicationDispense'
  readonly id: string
  readonly meta: Meta
  readonly extension: readonly WireExtension[]
  readonly identifier: readonly Identifier[]
  readonly status: 'completed'
  readonly medicationCodeableConcept: CodeableConcept
  readonly subject: { readonly reference: string; readonly display: '' }
  readonly authorizingPrescription: readonly WireReference[]
  readonly quantity: { readonly value: number }
  readonly daysSupply: { readonly value: number }
  readonly whenPrepared: string
  readonly whenHandedOver: string
}

interface Identifier {
  readonly system: string
  readonly value: string
}

/** One searchset entry. */
interface Entry {
  readonly fullUrl: string
  readonly search: { readonly mode: 'include' }
  readonly resource: CarebookMedicationRequest | CarebookMedicationDispense
}

/** The whole searchset body. */
interface CarebookSearchset {
  readonly resourceType: 'Bundle'
  readonly type: 'searchset'
  readonly total: number
  readonly link: readonly [{ readonly relation: 'self'; readonly url: string }]
  readonly entry: readonly Entry[]
}

/**
 * The prescriptions-list URL for `account`, with the `_revinclude`s the
 * portal sends; `rexall-be-well-source`'s `MedicationListResponseKind`
 * recognizes it.
 */
const medicationListUrlOf = (account: RexallAccount): string =>
  `${STU3_BASE}/pharmacy/Location?subject=Patient/${account.uid}&_id=${account.pharmacyLocationId}` +
  '&_query=lastActiveOnly' +
  ['MedicationRequest', 'MedicationDispense', 'DocumentReference', 'Immunization']
    .map((resourceType) => `&_revinclude=${resourceType}:extension.medicationrecord-processor`)
    .join('') +
  '&_count=2147483646'

/** When a fill was prepared and handed over. */
interface FillTimes {
  readonly whenPrepared: DateTime.Utc
  readonly whenHandedOver: DateTime.Utc
}

/**
 * A prescription with the ids and instants its carebook records carry: ids
 * hashed from the account and the prescription's key, instants on the days
 * the story set.
 */
interface CarebookPrescription {
  readonly prescription: Prescription.Prescription
  /** Shared by the request and its dispense, as the capture shows. */
  readonly resourceId: string
  readonly medicationId: string
  readonly identifiers: readonly Identifier[]
  readonly authoredOn: DateTime.Utc
  /** The most recent fill's times, or `null` for a prescription never filled. */
  readonly lastFill: FillTimes | null
}

/** Keys and dates `prescription` for `account` — see {@link CarebookPrescription}. */
const carebookPrescriptionOf = (
  asOf: DateTime.Utc,
  account: RexallAccount,
  prescription: Prescription.Prescription
): CarebookPrescription => {
  const keys = ['rexall', account.uid, prescription.key]
  const lastFillDay = prescription.fillDays.at(-1)
  const lastFillKeys = [...keys, 'fill', String(prescription.fillDays.length)]
  const whenPrepared =
    lastFillDay === undefined ? null : instantOn(asOf, lastFillDay, lastFillKeys, 15, 19)
  return {
    prescription,
    resourceId: Seeded.uuidOf(keys),
    medicationId: Seeded.uuidOf([...keys, 'medication']),
    identifiers: [
      {
        system: CarebookIdentifierSystem.MedicationRequestExternalId,
        value: Seeded.digitsOf([...keys, 'rx-number'], 7),
      },
      {
        system: CarebookIdentifierSystem.MedicationRequestExternalAuthorizingId,
        value: Seeded.digitsOf([...keys, 'authorizing-id'], 9),
      },
    ],
    // Before 15:00 UTC, the earliest a fill is prepared, so a first fill on
    // the day it is written still follows it.
    authoredOn: instantOn(asOf, prescription.written.day, [...keys, 'written'], 13, 15),
    lastFill:
      whenPrepared === null
        ? null
        : {
            whenPrepared,
            whenHandedOver: DateTime.add(whenPrepared, {
              seconds: Seeded.integerOf([...lastFillKeys, 'handed-over'], 1800, 10_800),
            }),
          },
  }
}

/**
 * `meta` for a prescription's records: one version per fill, last updated
 * when the most recent fill was handed over (or, unfilled, when written).
 */
const metaOf = (carebookPrescription: CarebookPrescription): Meta => ({
  versionId: String(carebookPrescription.prescription.fillDays.length + 1),
  lastUpdated: carebookTimestampOf(
    carebookPrescription.lastFill?.whenHandedOver ?? carebookPrescription.authoredOn
  ),
})

/** The product as `medication[x]`: the vendor DIN coding and the label. */
const medicationConceptOf = (product: DrugProduct.DrugProduct): CodeableConcept => ({
  coding: [{ system: CarebookCodingSystem.Din, code: product.din }],
  text: DrugProduct.labelOf(product),
})

const containedMedicationOf = (carebookPrescription: CarebookPrescription): ContainedMedication => {
  const { product } = carebookPrescription.prescription
  return {
    resourceType: 'Medication',
    id: carebookPrescription.medicationId,
    meta: metaOf(carebookPrescription),
    text: { status: 'generated', div: DrugProduct.labelOf(product) },
    extension: [
      {
        url: CarebookExtension.MedicationStrength,
        valueString: DrugProduct.strengthLabelOf(product),
      },
      {
        url: CarebookExtension.MedicationDescription,
        valueString: `${DrugProduct.strengthLabelOf(product)} - ${product.brandName}`,
      },
    ],
    code: medicationConceptOf(product),
    status: 'active',
    manufacturer: { display: product.company },
    form: { coding: [{ system: CarebookCodingSystem.MedicationForm, code: product.form }] },
  }
}

/** The carebook pharmacy reference both resources name their processor with. */
const pharmacyReferenceOf = (account: RexallAccount): WireReference => ({
  reference: `rexall-pharmacy-location/${account.pharmacyLocationId}`,
  identifier: { value: account.pharmacyLocationId },
})

/** The patient both resources are about: the profile's `uid`, with the dialect's empty `display`. */
const patientReferenceOf = (account: RexallAccount): CarebookMedicationRequest['subject'] => ({
  reference: `Patient/${account.uid}`,
  display: '',
})

const medicationRequestOf = (
  account: RexallAccount,
  carebookPrescription: CarebookPrescription,
  sortOrder: number
): CarebookMedicationRequest => {
  const { prescription } = carebookPrescription
  const repeatsRemaining = Prescription.repeatsRemainingOf(prescription)
  const estimatedPickUp: readonly WireExtension[] =
    carebookPrescription.lastFill === null
      ? []
      : [
          {
            url: CarebookExtension.RequestEstimatedPickUp,
            valueDateTime: carebookTimestampOf(carebookPrescription.lastFill.whenHandedOver),
          },
        ]
  return {
    resourceType: 'MedicationRequest',
    id: carebookPrescription.resourceId,
    meta: metaOf(carebookPrescription),
    contained: [containedMedicationOf(carebookPrescription)],
    extension: [
      ...estimatedPickUp,
      {
        url: CarebookExtension.RequestType,
        valueCodeableConcept: {
          coding: [
            {
              system: CarebookCodingSystem.RequestType,
              code:
                prescription.fillDays.length > 1 ? RequestTypeCode.Refill : RequestTypeCode.Fill,
            },
          ],
        },
      },
      { url: CarebookExtension.ExternalSystemSource, valueString: REXALL_SYSTEM_SOURCE },
      { url: CarebookExtension.InputSource, valueString: 'Sync' },
      {
        url: CarebookExtension.RequestMedicationProcessor,
        valueReference: pharmacyReferenceOf(account),
      },
      {
        url: CarebookExtension.RequestMedicationRecordProcessor,
        valueReference: pharmacyReferenceOf(account),
      },
      { url: CarebookExtension.DoNotPerform, valueBoolean: false },
      { url: CarebookExtension.Renewable, valueBoolean: prescription.repeatsAllowed > 0 },
      { url: CarebookExtension.RequestExternalStoreId, valueString: account.storeId },
      { url: CarebookExtension.SortOrder, valuePositiveInt: sortOrder },
      {
        url: CarebookExtension.PrescriptionOrder,
        valueReference: {
          reference: 'PrescriptionOrder/null',
          identifier: { value: 'null' },
          display: 'todo',
        },
      },
    ],
    identifier: carebookPrescription.identifiers,
    status: Prescription.statusOf(prescription),
    intent: 'order',
    medicationCodeableConcept: medicationConceptOf(prescription.product),
    subject: patientReferenceOf(account),
    authoredOn: carebookTimestampOf(carebookPrescription.authoredOn),
    requester: {
      agent: {
        reference: `Practitioner/${Seeded.uuidOf(['rexall', 'practitioner', prescription.prescriber.key])}`,
        display: prescription.prescriber.display,
      },
    },
    note: [{ text: Prescription.sigOf(prescription) }],
    dispenseRequest: {
      modifierExtension: [
        { url: CarebookExtension.NumberOfRepeatsAvailable, valuePositiveInt: repeatsRemaining },
        { url: CarebookExtension.NumberOfRepeatsAvailableV2, valueDecimal: repeatsRemaining },
      ],
      numberOfRepeatsAllowed: prescription.repeatsAllowed,
      quantity: { value: Prescription.quantityPerFillOf(prescription) },
      expectedSupplyDuration: { value: prescription.supplyDaysPerFill },
    },
  }
}

const medicationDispenseOf = (
  account: RexallAccount,
  carebookPrescription: CarebookPrescription,
  lastFill: FillTimes
): CarebookMedicationDispense => {
  const { prescription } = carebookPrescription
  const prescriptionOrder = `PrescriptionOrder/${Seeded.uuidOf(['rexall', account.uid, prescription.key, 'order'])}`
  return {
    resourceType: 'MedicationDispense',
    id: carebookPrescription.resourceId,
    meta: metaOf(carebookPrescription),
    extension: [
      {
        url: CarebookExtension.WhenRequested,
        valueDateTime: carebookTimestampOf(lastFill.whenPrepared),
      },
      {
        url: CarebookExtension.DispenseEstimatedPickUp,
        valueDateTime: carebookTimestampOf(lastFill.whenHandedOver),
      },
      { url: CarebookExtension.DispensedInApp, valueBoolean: prescription.fillDays.length > 1 },
      { url: CarebookExtension.MedicationProcessorTimezone, valueString: PHARMACY_TIME_ZONE },
      { url: CarebookExtension.ExternalSystemSource, valueString: REXALL_SYSTEM_SOURCE },
      {
        url: CarebookExtension.DispenseMedicationProcessor,
        valueReference: pharmacyReferenceOf(account),
      },
      {
        url: CarebookExtension.DispenseMedicationRecordProcessor,
        valueReference: pharmacyReferenceOf(account),
      },
      { url: CarebookExtension.DispenseExternalStoreId, valueString: account.storeId },
    ],
    identifier: carebookPrescription.identifiers,
    status: 'completed',
    medicationCodeableConcept: medicationConceptOf(prescription.product),
    subject: patientReferenceOf(account),
    authorizingPrescription: [
      CarebookIdentifierSystem.MedicationRequestTypeOrder,
      CarebookIdentifierSystem.MedicationRequestTypeRefill,
    ].map((system) => ({
      reference: prescriptionOrder,
      identifier: { system, value: carebookPrescription.resourceId },
    })),
    quantity: { value: Prescription.quantityPerFillOf(prescription) },
    daysSupply: { value: prescription.supplyDaysPerFill },
    whenPrepared: carebookTimestampOf(lastFill.whenPrepared),
    whenHandedOver: carebookTimestampOf(lastFill.whenHandedOver),
  }
}

const entryOf = (resource: CarebookMedicationRequest | CarebookMedicationDispense): Entry => ({
  fullUrl: `${STU3_BASE}/${resource.resourceType}/${resource.id}`,
  search: { mode: 'include' },
  resource,
})

/**
 * The searchset the prescriptions list returns for `prescriptions`: every
 * request, in story order, then the dispense of each one's most recent fill.
 *
 * @param asOf - The as-of instant the story's days are dated from
 * @param account - The Rexall account the list belongs to
 * @param prescriptions - The prescriptions filled under it
 */
const searchsetOf = (
  asOf: DateTime.Utc,
  account: RexallAccount,
  prescriptions: readonly Prescription.Prescription[]
): CarebookSearchset => {
  const carebookPrescriptions = prescriptions.map((prescription) =>
    carebookPrescriptionOf(asOf, account, prescription)
  )
  const requests = carebookPrescriptions.map((each, index) =>
    medicationRequestOf(account, each, index + 1)
  )
  const dispenses = carebookPrescriptions.flatMap((each) =>
    each.lastFill === null ? [] : [medicationDispenseOf(account, each, each.lastFill)]
  )
  const entry = [...requests, ...dispenses].map(entryOf)
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: entry.length,
    link: [{ relation: 'self', url: medicationListUrlOf(account) }],
    entry,
  }
}

export { medicationListUrlOf, searchsetOf }
export type { CarebookMedicationDispense, CarebookMedicationRequest, CarebookSearchset }
