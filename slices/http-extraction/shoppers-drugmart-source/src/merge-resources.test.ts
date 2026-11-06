import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type { MedicationDispense } from '@wildflowerhealthio/fhir-r4/resources'
import { makeHttpResponse } from '@wildflowerhealthio/http-extraction-fundamentals/test-helpers'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { mergeShoppersResources } from './merge-resources.ts'
import { customerUrlOf, prescriptionHistoryUrlOf, prescriptionStatusUrlOf } from './portal-url.ts'
import { ShoppersIdentifierSystem, shoppersStoreLocatorUrl } from './shoppers.ts'
import { shoppersDrugMartSource } from './source.ts'

/**
 * The merge over what the source's kinds really emit, as the HAR importer
 * holds them when it merges: one account managing one person, whose one fill is in both
 * prescription feeds.
 */

const ACCOUNT_ID = 'a7353645-83bf-4371-8b87-486b3d5b9802'
const PERSON_ID = 'c0ffee00-0000-4000-8000-000000000001'
const PRESCRIPTION_ID = 'rx-uuid-1'
const DISPENSE_ID = 'disp-1'
const STORE_ID = 9000
const STORE_NAME = 'SDM Pharmacy #9000'

const decodeReference = Schema.decodeUnknownSync(IdentifierAndReference.ReferenceSchema)

/** What the source's kinds make of `payload` served at `url`. */
const extract = (url: string, payload: unknown): readonly DetachedResource.Type[] => {
  const kind = shoppersDrugMartSource.responseKinds.find((candidate) =>
    Option.isSome(candidate.tryRecognize(url, Option.some('GET')))
  )
  if (kind === undefined) throw new Error(`no Shoppers kind claims ${url}`)
  return Effect.runSync(kind.parse(makeHttpResponse({ url, body: JSON.stringify(payload) })))
}

/** A dispense the source's kinds made, detached. */
type DetachedDispense = MedicationDispense.Type & { readonly id: null }

/** Whether `resource` is a dispense, keeping whatever else its type says of it. */
const isDispense = <TResource extends DetachedResource.Type>(
  resource: TResource
): resource is TResource & MedicationDispense.Type => resource.resourceType === 'MedicationDispense'

const dispensesOf = <TResource extends DetachedResource.Type>(
  resources: readonly TResource[]
): readonly (TResource & MedicationDispense.Type)[] => resources.filter(isDispense)

/** The one dispense `resources` holds. */
const onlyDispenseOf = <TResource extends DetachedResource.Type>(
  resources: readonly TResource[]
): TResource & MedicationDispense.Type => {
  const [dispense, ...rest] = dispensesOf(resources)
  if (dispense === undefined || rest.length > 0) throw new Error('expected exactly one dispense')
  return dispense
}

const CUSTOMERS_PAYLOAD = { customer: { patients: [{ id: PERSON_ID, firstName: 'Ada' }] } }

const customers = (): readonly DetachedResource.Type[] =>
  extract(customerUrlOf(ACCOUNT_ID), CUSTOMERS_PAYLOAD)

/** The status feed's payload; `din` is the prescription's, when it states one. */
const statusPayload = (din?: string): unknown => ({
  id: PRESCRIPTION_ID,
  patientId: PERSON_ID,
  prescriptionNumber: 9534360,
  brandName: 'Amoxil',
  storeId: STORE_ID,
  ...(din === undefined ? {} : { din }),
  dispenses: [{ dispenseId: DISPENSE_ID, status: 'IN_PROGRESS', quantityDispensed: 30 }],
})

/** The status feed's copy of the fill, detached. */
const statusCopy = (din?: string): DetachedDispense =>
  onlyDispenseOf(extract(prescriptionStatusUrlOf(PRESCRIPTION_ID), statusPayload(din)))

const HISTORY_PAYLOAD = {
  dispenses: [
    {
      prescriptionId: PRESCRIPTION_ID,
      dispenseId: DISPENSE_ID,
      prescriptionNumber: 9534360,
      brandName: 'Apo-Amoxi',
      din: '80717730',
      quantityDispensed: 30,
      store: { id: STORE_ID, storeName: STORE_NAME },
    },
  ],
}

/** The history feed's copy of the same fill, detached. */
const historyCopy = (): DetachedDispense =>
  onlyDispenseOf(extract(prescriptionHistoryUrlOf(ACCOUNT_ID), HISTORY_PAYLOAD))

/** `system` and `value` as the qualified identifier a detached record or reference carries. */
const identifierIn = (system: string, value: string): IdentifierAndReference.IdentifierType =>
  Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)({ system, value })

describe('shoppersDrugMartSource', () => {
  it('should merge with mergeShoppersResources', () => {
    expect(shoppersDrugMartSource.mergeResources).toBe(mergeShoppersResources)
  })

  it("should key each record by the portal's own id for it, in the portal's system for its type", () => {
    const [person] = customers()
    const request = extract(prescriptionStatusUrlOf(PRESCRIPTION_ID), statusPayload()).find(
      (resource) => resource.resourceType === 'MedicationRequest'
    )

    expect(Option.flatMap(Option.fromNullable(person), DetachedResource.keyOf)).toStrictEqual(
      Option.some({ system: ShoppersIdentifierSystem.PatientId, value: PERSON_ID })
    )
    expect(Option.flatMap(Option.fromNullable(request), DetachedResource.keyOf)).toStrictEqual(
      Option.some({ system: ShoppersIdentifierSystem.PrescriptionId, value: PRESCRIPTION_ID })
    )
    expect(DetachedResource.keyOf(statusCopy())).toStrictEqual(
      Option.some({ system: ShoppersIdentifierSystem.DispenseId, value: DISPENSE_ID })
    )
  })

  // One wording per fact: the family says what a Shoppers id is, so the key is
  // written once and the prescription keeps its number beside it.
  it('should carry each key once, the prescription its number behind it', () => {
    const [person] = customers()
    const request = extract(prescriptionStatusUrlOf(PRESCRIPTION_ID), statusPayload()).find(
      (resource) => resource.resourceType === 'MedicationRequest'
    )

    expect(person?.resourceType === 'Patient' ? person.identifier : null).toStrictEqual([
      identifierIn(ShoppersIdentifierSystem.PatientId, PERSON_ID),
    ])
    expect(request?.resourceType === 'MedicationRequest' ? request.identifier : null).toStrictEqual(
      [
        identifierIn(ShoppersIdentifierSystem.PrescriptionId, PRESCRIPTION_ID),
        identifierIn(ShoppersIdentifierSystem.PrescriptionNumber, '9534360'),
      ]
    )
    expect(historyCopy().identifier).toStrictEqual([
      identifierIn(ShoppersIdentifierSystem.DispenseId, DISPENSE_ID),
    ])
  })

  it('should name the person by their key in the status copy, and no one in the history copy', () => {
    expect(statusCopy().subject).toStrictEqual(
      decodeReference({
        type: 'Patient',
        identifier: { system: ShoppersIdentifierSystem.PatientId, value: PERSON_ID },
      })
    )
    expect(historyCopy().subject).toBeNull()
  })

  it("should name the history copy's prescription by its key, which replaces the number on the reference", () => {
    expect(historyCopy().authorizingPrescription).toStrictEqual([
      decodeReference({
        type: 'MedicationRequest',
        identifier: { system: ShoppersIdentifierSystem.PrescriptionId, value: PRESCRIPTION_ID },
      }),
    ])
  })

  it('should give both copies of one fill the same key', () => {
    expect(DetachedResource.keyOf(historyCopy())).toStrictEqual(
      DetachedResource.keyOf(statusCopy())
    )
  })
})

describe('mergeShoppersResources', () => {
  it('should merge the two copies of a fill to the same dispense in either arrival order', () => {
    expect(mergeShoppersResources(historyCopy(), statusCopy())).toStrictEqual(
      mergeShoppersResources(statusCopy(), historyCopy())
    )
  })

  it("should keep the status copy's subject, status, request link and store link", () => {
    const status = statusCopy()

    const merged = mergeShoppersResources(historyCopy(), status)

    if (merged.resourceType !== 'MedicationDispense') throw new Error('expected a dispense')
    expect({
      subject: merged.subject,
      status: merged.status,
      authorizingPrescription: merged.authorizingPrescription,
      storeLink: merged.location?.reference,
    }).toStrictEqual({
      subject: status.subject,
      status: 'in-progress',
      authorizingPrescription: status.authorizingPrescription,
      storeLink: shoppersStoreLocatorUrl(STORE_ID),
    })
  })

  it('should name the store as the history copy does, and take its DIN when the status copy has none', () => {
    const history = historyCopy()

    const merged = mergeShoppersResources(statusCopy(), history)

    if (merged.resourceType !== 'MedicationDispense') throw new Error('expected a dispense')
    expect(merged.location?.display).toBe(STORE_NAME)
    expect(merged.medicationCodeableConcept).toStrictEqual(history.medicationCodeableConcept)
  })

  it("should keep the status copy's medication when it carries a DIN", () => {
    const status = statusCopy('51480840')

    const merged = mergeShoppersResources(historyCopy(), status)

    if (merged.resourceType !== 'MedicationDispense') throw new Error('expected a dispense')
    expect(merged.medicationCodeableConcept).toStrictEqual(status.medicationCodeableConcept)
  })

  it('should keep the later of two copies from one feed', () => {
    const earlier = statusCopy()
    const later = statusCopy('51480840')

    expect(mergeShoppersResources(earlier, later)).toBe(later)
  })

  it('should keep the later copy of anything but a dispense', () => {
    const [earlier] = customers()
    const [later] = customers()
    if (earlier === undefined || later === undefined) throw new Error('expected a Patient')

    expect(mergeShoppersResources(earlier, later)).toBe(later)
  })
})
