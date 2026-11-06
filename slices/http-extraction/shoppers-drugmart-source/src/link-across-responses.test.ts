import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'
import { makeHttpResponse } from '@wildflowerhealthio/http-extraction-fundamentals/test-helpers'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { linkShoppersResponses } from './link-across-responses.ts'
import { mergeShoppersResources } from './merge-resources.ts'
import { customerUrlOf, prescriptionHistoryUrlOf, prescriptionStatusUrlOf } from './portal-url.ts'
import { shoppersDrugMartSource } from './source.ts'

/**
 * The link over what the source's kinds really emit, as the HAR importer
 * holds them when it links: each response's URL and records, after the merge.
 */

const ACCOUNT_ID = 'a7353645-83bf-4371-8b87-486b3d5b9802'
const OTHER_ACCOUNT_ID = 'b7353645-83bf-4371-8b87-486b3d5b9803'
const PERSON_ID = 'c0ffee00-0000-4000-8000-000000000001'
const DEPENDENT_ID = 'c0ffee00-0000-4000-8000-000000000002'
const PRESCRIPTION_ID = 'rx-uuid-1'

type Response = SourceDescriptor.ResponseRecords<DetachedResource.Type>

/** `payload` served at `url`, as the source's kind that claims it parses it. */
const responseAt = (url: string, payload: unknown): Response => {
  const kind = shoppersDrugMartSource.responseKinds.find((candidate) =>
    Option.isSome(candidate.tryRecognize(url, Option.some('GET')))
  )
  if (kind === undefined) throw new Error(`no Shoppers kind claims ${url}`)
  const records = Effect.runSync(
    kind.parse(makeHttpResponse({ url, body: JSON.stringify(payload) }))
  )
  return { url, records }
}

/** The customers response of `accountId`, listing a person per id of `personIds`. */
const customersOf = (accountId: string, personIds: readonly string[]): Response =>
  responseAt(customerUrlOf(accountId), {
    customer: { patients: personIds.map((id) => ({ id, firstName: 'Ada' })) },
  })

/** The history response of `accountId`, with a fill per id of `dispenseIds`. */
const historyOf = (accountId: string, dispenseIds: readonly string[]): Response =>
  responseAt(prescriptionHistoryUrlOf(accountId), {
    dispenses: dispenseIds.map((dispenseId) => ({
      prescriptionId: PRESCRIPTION_ID,
      dispenseId,
      brandName: 'Apo-Amoxi',
    })),
  })

/** The status response of `PRESCRIPTION_ID`, for `personId`, with a fill per id of `dispenseIds`. */
const statusOf = (personId: string, dispenseIds: readonly string[]): Response =>
  responseAt(prescriptionStatusUrlOf(PRESCRIPTION_ID), {
    id: PRESCRIPTION_ID,
    patientId: personId,
    brandName: 'Amoxil',
    dispenses: dispenseIds.map((dispenseId) => ({ dispenseId, status: 'IN_PROGRESS' })),
  })

/** The `subject` of each dispense in `response`. */
const subjectsOf = (response: Response | undefined): readonly unknown[] =>
  (response?.records ?? []).flatMap((record) =>
    record.resourceType === 'MedicationDispense' ? [record.subject] : []
  )

/** The subject the status feed names `personId` by. */
const statusSubjectOf = (personId: string): unknown => subjectsOf(statusOf(personId, ['any']))[0]

describe('linkShoppersResponses', () => {
  it("is the source's linkAcrossResponses", () => {
    expect(shoppersDrugMartSource.linkAcrossResponses).toBe(linkShoppersResponses)
  })

  it("files an account of one's history fills on its person, as the status feed names them", () => {
    const linked = linkShoppersResponses([
      customersOf(ACCOUNT_ID, [PERSON_ID]),
      historyOf(ACCOUNT_ID, ['disp-1', 'disp-2']),
    ])

    const expected = statusSubjectOf(PERSON_ID)
    expect(subjectsOf(linked[1])).toStrictEqual([expected, expected])
  })

  it('files them whichever of the two responses comes first', () => {
    const linked = linkShoppersResponses([
      historyOf(ACCOUNT_ID, ['disp-1']),
      customersOf(ACCOUNT_ID, [PERSON_ID]),
    ])

    expect(subjectsOf(linked[0])).toStrictEqual([statusSubjectOf(PERSON_ID)])
  })

  it.each([
    {
      label: 'the account manages several people',
      customers: [customersOf(ACCOUNT_ID, [PERSON_ID, DEPENDENT_ID])],
    },
    { label: 'the file holds no customers response', customers: [] },
    {
      label: "the file holds only another account's customers response",
      customers: [customersOf(OTHER_ACCOUNT_ID, [PERSON_ID])],
    },
    {
      label: "the account's customers responses name different people",
      customers: [customersOf(ACCOUNT_ID, [PERSON_ID]), customersOf(ACCOUNT_ID, [DEPENDENT_ID])],
    },
    {
      label: 'one of its customers responses lists several people',
      customers: [
        customersOf(ACCOUNT_ID, [PERSON_ID]),
        customersOf(ACCOUNT_ID, [PERSON_ID, DEPENDENT_ID]),
      ],
    },
  ])('leaves the fills naming the account when $label', ({ customers }) => {
    const history = historyOf(ACCOUNT_ID, ['disp-1'])

    const linked = linkShoppersResponses([...customers, history])

    expect(linked).toStrictEqual([...customers, history])
  })

  it('files them when two customers responses of the account list the same one person', () => {
    const linked = linkShoppersResponses([
      customersOf(ACCOUNT_ID, [PERSON_ID]),
      customersOf(ACCOUNT_ID, [PERSON_ID]),
      historyOf(ACCOUNT_ID, ['disp-1']),
    ])

    expect(subjectsOf(linked[2])).toStrictEqual([statusSubjectOf(PERSON_ID)])
  })

  it("files only that account's fills, not another account's", () => {
    const otherHistory = historyOf(OTHER_ACCOUNT_ID, ['disp-9'])

    const linked = linkShoppersResponses([
      customersOf(ACCOUNT_ID, [PERSON_ID]),
      historyOf(ACCOUNT_ID, ['disp-1']),
      otherHistory,
    ])

    expect(linked[2]).toStrictEqual(otherHistory)
  })

  it('leaves a merged fill, which already names its person, as the merge made it', () => {
    // A history response holding the merge of a fill both feeds carried, in
    // the history copy's place: it names the status copy's person.
    const [historyCopy] = historyOf(ACCOUNT_ID, ['disp-1']).records
    const [, statusCopy] = statusOf(DEPENDENT_ID, ['disp-1']).records
    if (historyCopy === undefined || statusCopy === undefined) throw new Error('expected copies')
    const merged = {
      url: prescriptionHistoryUrlOf(ACCOUNT_ID),
      records: [mergeShoppersResources(historyCopy, statusCopy)],
    }

    const linked = linkShoppersResponses([customersOf(ACCOUNT_ID, [PERSON_ID]), merged])

    expect(subjectsOf(linked[1])).toStrictEqual([statusSubjectOf(DEPENDENT_ID)])
  })

  it('leaves the customers and status responses as they are', () => {
    const customers = customersOf(ACCOUNT_ID, [PERSON_ID])
    const status = statusOf(PERSON_ID, ['disp-1'])

    const linked = linkShoppersResponses([customers, status, historyOf(ACCOUNT_ID, ['disp-2'])])

    expect(linked.slice(0, 2)).toStrictEqual([customers, status])
  })
})
