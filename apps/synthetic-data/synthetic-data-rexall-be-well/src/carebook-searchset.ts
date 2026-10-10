import type {
  CodeableConcept,
  Extension,
  IdentifierAndReference,
  Meta,
} from '@wildflowerhealthio/fhir-r4/data-types'
import type { Medication as R4Medication } from '@wildflowerhealthio/fhir-r4/resources'
import type { Medication as Stu3Medication } from '@wildflowerhealthio/fhir-stu3-as-r4/schemas'
import {
  CarebookCodingSystem,
  CarebookExtension,
  CarebookIdentifierSystem,
  carebookTimestampOf,
  type MedicationBundle,
  type MedicationResource,
  medicationListUrlOf,
  REXALL_STU3_BASE_URL,
  REXALL_SYSTEM_SOURCE,
  RequestTypeCode,
} from '@wildflowerhealthio/rexall-be-well-source'
import * as Seeding from '@wildflowerhealthio/synthetic-data-fundamentals/seeding'
import {
  DrugProduct,
  Prescription,
  StoryDay,
} from '@wildflowerhealthio/synthetic-data-fundamentals/story'
import { DateTime } from 'effect'

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
 * did.
 *
 * Every value is written as `rexall-be-well-source`'s schemas encode it
 * ({@link MedicationBundle}, {@link MedicationResource}), with every extension
 * URL, identifier and coding system spelled from its constants. The values are
 * built encoded rather than encoded from decoded ones: `DateTimeUtc` encodes as
 * `…000Z`, and the dialect writes every timestamp `+00:00`
 * ({@link carebookTimestampOf}).
 */

/** The whole searchset body. */
type CarebookSearchset = typeof MedicationBundle.Encoded

type Entry = NonNullable<CarebookSearchset['entry']>[number]

type CarebookMedicationRequest = Extract<
  typeof MedicationResource.Encoded,
  { readonly resourceType: 'MedicationRequest' }
>

type CarebookMedicationDispense = Extract<
  typeof MedicationResource.Encoded,
  { readonly resourceType: 'MedicationDispense' }
>

/**
 * The contained `Medication`. `fhir-stu3-as-r4` models only the fields its
 * decode reads; the dialect also sends `status` and `manufacturer`, which STU3
 * spells as R4 does.
 */
type ContainedMedication = typeof Stu3Medication.Schema.Encoded &
  Pick<typeof R4Medication.Schema.Encoded, 'status' | 'manufacturer'>

type WireExtension = typeof Extension.Schema.Encoded
type WireIdentifier = typeof IdentifierAndReference.IdentifierSchema.Encoded
type WireReference = typeof IdentifierAndReference.ReferenceSchema.Encoded

/** The dispensing pharmacy's zone, which the dialect records beside its `+00:00` timestamps. */
const PHARMACY_TIME_ZONE = 'America/Toronto'

/** The `input-source` every record in the capture carries. */
const INPUT_SOURCE = 'Sync'

/** The prescriptions-list URL for `account`, the searchset's `self` link. */
const medicationListUrlFor = (account: RexallAccount): string =>
  medicationListUrlOf({ profileUid: account.uid, pharmacyLocationId: account.pharmacyLocationId })

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
  /** The `PrescriptionOrder` a dispense's `authorizingPrescription` names. */
  readonly prescriptionOrderId: string
  readonly identifiers: readonly WireIdentifier[]
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
    lastFillDay === undefined ? null : StoryDay.instantOn(asOf, lastFillDay, lastFillKeys, 15, 19)
  return {
    prescription,
    resourceId: Seeding.uuidOf(keys),
    medicationId: Seeding.uuidOf([...keys, 'medication']),
    prescriptionOrderId: Seeding.uuidOf([...keys, 'order']),
    identifiers: [
      {
        system: CarebookIdentifierSystem.MedicationRequestExternalId,
        value: Seeding.digitsOf([...keys, 'rx-number'], 7),
      },
      {
        system: CarebookIdentifierSystem.MedicationRequestExternalAuthorizingId,
        value: Seeding.digitsOf([...keys, 'authorizing-id'], 9),
      },
    ],
    // Before 15:00 UTC, the earliest a fill is prepared, so a first fill on
    // the day it is written still follows it.
    authoredOn: StoryDay.instantOn(asOf, prescription.written.day, [...keys, 'written'], 13, 15),
    lastFill:
      whenPrepared === null
        ? null
        : {
            whenPrepared,
            whenHandedOver: DateTime.add(whenPrepared, {
              seconds: Seeding.integerOf([...lastFillKeys, 'handed-over'], 1800, 10_800),
            }),
          },
  }
}

/**
 * `meta` for a prescription's records: one version per fill, last updated
 * when the most recent fill was handed over (or, unfilled, when written).
 */
const metaOf = (carebookPrescription: CarebookPrescription): typeof Meta.Schema.Encoded => ({
  versionId: String(carebookPrescription.prescription.fillDays.length + 1),
  lastUpdated: carebookTimestampOf(
    carebookPrescription.lastFill?.whenHandedOver ?? carebookPrescription.authoredOn
  ),
})

/** The product as `medication[x]`: the vendor DIN coding and the label. */
const medicationConceptOf = (
  product: DrugProduct.DrugProduct
): typeof CodeableConcept.Schema.Encoded => ({
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

/** The carebook pharmacy location both resources name as their processor. */
const pharmacyLocationReferenceOf = (account: RexallAccount): WireReference => ({
  reference: `rexall-pharmacy-location/${account.pharmacyLocationId}`,
  identifier: { value: account.pharmacyLocationId },
})

/** The patient both resources are about: the profile's `uid`, with the dialect's empty `display`. */
const patientReferenceOf = (account: RexallAccount): WireReference => ({
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
      { url: CarebookExtension.InputSource, valueString: INPUT_SOURCE },
      {
        url: CarebookExtension.RequestMedicationProcessor,
        valueReference: pharmacyLocationReferenceOf(account),
      },
      {
        url: CarebookExtension.RequestMedicationRecordProcessor,
        valueReference: pharmacyLocationReferenceOf(account),
      },
      { url: CarebookExtension.DoNotPerform, valueBoolean: false },
      { url: CarebookExtension.Renewable, valueBoolean: prescription.repeatsAllowed > 0 },
      { url: CarebookExtension.RequestExternalStoreId, valueString: account.storeId },
      { url: CarebookExtension.SortOrder, valuePositiveInt: sortOrder },
      {
        // The capture's unpopulated stub.
        url: CarebookExtension.PrescriptionOrder,
        valueReference: {
          reference: 'PrescriptionOrder/null',
          identifier: { value: 'null' },
          display: 'todo',
        },
      },
    ],
    identifier: [...carebookPrescription.identifiers],
    status: Prescription.statusOf(prescription),
    intent: 'order',
    medicationCodeableConcept: medicationConceptOf(prescription.product),
    subject: patientReferenceOf(account),
    authoredOn: carebookTimestampOf(carebookPrescription.authoredOn),
    requester: {
      agent: {
        reference: `Practitioner/${Seeding.uuidOf(['rexall', 'practitioner', prescription.prescriber.key])}`,
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
        valueReference: pharmacyLocationReferenceOf(account),
      },
      {
        url: CarebookExtension.DispenseMedicationRecordProcessor,
        valueReference: pharmacyLocationReferenceOf(account),
      },
      { url: CarebookExtension.DispenseExternalStoreId, valueString: account.storeId },
    ],
    identifier: [...carebookPrescription.identifiers],
    status: 'completed',
    medicationCodeableConcept: medicationConceptOf(prescription.product),
    subject: patientReferenceOf(account),
    authorizingPrescription: [
      CarebookIdentifierSystem.MedicationRequestTypeOrder,
      CarebookIdentifierSystem.MedicationRequestTypeRefill,
    ].map((system) => ({
      reference: `PrescriptionOrder/${carebookPrescription.prescriptionOrderId}`,
      identifier: { system, value: carebookPrescription.resourceId },
    })),
    quantity: { value: Prescription.quantityPerFillOf(prescription) },
    daysSupply: { value: prescription.supplyDaysPerFill },
    whenPrepared: carebookTimestampOf(lastFill.whenPrepared),
    whenHandedOver: carebookTimestampOf(lastFill.whenHandedOver),
  }
}

const entryOf = (resource: CarebookMedicationRequest | CarebookMedicationDispense): Entry => ({
  fullUrl: `${REXALL_STU3_BASE_URL}/${resource.resourceType}/${resource.id}`,
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
  const requests = carebookPrescriptions.map((carebookPrescription, index) =>
    medicationRequestOf(account, carebookPrescription, index + 1)
  )
  const dispenses = carebookPrescriptions.flatMap((carebookPrescription) =>
    carebookPrescription.lastFill === null
      ? []
      : [medicationDispenseOf(account, carebookPrescription, carebookPrescription.lastFill)]
  )
  const entry = [...requests, ...dispenses].map(entryOf)
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    total: entry.length,
    link: [{ relation: 'self', url: medicationListUrlFor(account) }],
    entry,
  }
}

export { medicationListUrlFor, searchsetOf }
