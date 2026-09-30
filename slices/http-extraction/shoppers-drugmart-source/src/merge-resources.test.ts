import { Effect, Option } from 'effect'
import type { FhirResource, MedicationDispense } from 'fhir-r4/resources'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { describe, expect, it } from 'vite-plus/test'

import { mergeShoppersResources } from './merge-resources.ts'
import { customerUrlOf, prescriptionHistoryUrlOf, prescriptionStatusUrlOf } from './portal-url.ts'
import { shoppersStoreLocatorUrl } from './shoppers.ts'
import { shoppersDrugMartSource } from './source.ts'

/**
 * The merge over what the source's pre-adopted kinds really emit: one account
 * managing one person, whose one fill is in both prescription feeds.
 */

const ACCOUNT_ID = 'a7353645-83bf-4371-8b87-486b3d5b9802'
const PERSON_ID = 'c0ffee00-0000-4000-8000-000000000001'
const PRESCRIPTION_ID = 'rx-uuid-1'
const DISPENSE_ID = 'disp-1'
const STORE_ID = 9000
const STORE_NAME = 'SDM Pharmacy #9000'

/** What the source's kinds make of `payload` served at `url`. */
const extract = (url: string, payload: unknown): readonly FhirResource[] => {
  const kind = shoppersDrugMartSource.responseKinds.find((candidate) =>
    Option.isSome(candidate.tryRecognize(url, Option.some('GET')))
  )
  if (kind === undefined) throw new Error(`no Shoppers kind claims ${url}`)
  return Effect.runSync(kind.parse(makeHttpResponse({ url, body: JSON.stringify(payload) })))
}

const dispensesOf = (resources: readonly FhirResource[]): readonly MedicationDispense.Type[] =>
  resources.flatMap((resource) =>
    resource.resourceType === 'MedicationDispense' ? [resource] : []
  )

/** The one dispense `resources` holds. */
const onlyDispenseOf = (resources: readonly FhirResource[]): MedicationDispense.Type => {
  const [dispense, ...rest] = dispensesOf(resources)
  if (dispense === undefined || rest.length > 0) throw new Error('expected exactly one dispense')
  return dispense
}

const customers = (): readonly FhirResource[] =>
  extract(customerUrlOf(ACCOUNT_ID), {
    customer: { pcid: ACCOUNT_ID, patients: [{ id: PERSON_ID, firstName: 'Ada' }] },
  })

/** The status feed's copy; `din` is the prescription's, when it states one. */
const statusCopy = (din?: string): MedicationDispense.Type =>
  onlyDispenseOf(
    extract(prescriptionStatusUrlOf(PRESCRIPTION_ID), {
      id: PRESCRIPTION_ID,
      patientId: PERSON_ID,
      brandName: 'Amoxil',
      storeId: STORE_ID,
      ...(din === undefined ? {} : { din }),
      dispenses: [{ dispenseId: DISPENSE_ID, status: 'IN_PROGRESS', quantityDispensed: 30 }],
    })
  )

/** The history feed's copy of the same fill. */
const historyCopy = (): MedicationDispense.Type =>
  onlyDispenseOf(
    extract(prescriptionHistoryUrlOf(ACCOUNT_ID), {
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
    })
  )

describe('shoppersDrugMartSource', () => {
  it('should merge with mergeShoppersResources', () => {
    expect(shoppersDrugMartSource.mergeResources).toBe(mergeShoppersResources)
  })

  it("should adopt a history dispense's subject onto the account Patient the customers feed keys", () => {
    const accountPatient = customers().find(
      (resource) => resource.resourceType === 'Patient' && resource.link.length > 0
    )

    expect(accountPatient?.id).toEqual(expect.stringMatching(/^wf-/))
    expect(historyCopy().subject?.reference).toBe(`Patient/${accountPatient?.id}`)
  })

  it('should give both copies of one fill the same adopted id', () => {
    expect(historyCopy().id).toBe(statusCopy().id)
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
