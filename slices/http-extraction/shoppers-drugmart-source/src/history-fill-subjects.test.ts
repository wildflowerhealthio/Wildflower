import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { makeHttpResponse } from '@wildflowerhealthio/http-extraction-fundamentals/test-helpers'
import { Effect, Logger, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { completeShoppersExtraction } from './history-fill-subjects.ts'
import { customerUrlOf, prescriptionHistoryUrlOf, prescriptionStatusUrlOf } from './portal-url.ts'
import { shoppersDrugMartSource } from './source.ts'

/**
 * The completion over what the source's pre-adopted kinds really emit: an
 * account managing one or two people, the history feed listing their fills.
 */

const ACCOUNT_ID = 'a7353645-83bf-4371-8b87-486b3d5b9802'
const DANA_ID = 'c0ffee00-0000-4000-8000-000000000001'
const SAM_ID = 'c0ffee00-0000-4000-8000-000000000002'

/** What the source's kinds make of `payload` served at `url`. */
const extract = (url: string, payload: unknown): readonly FhirResource[] => {
  const kind = shoppersDrugMartSource.responseKinds.find((candidate) =>
    Option.isSome(candidate.tryRecognize(url, Option.some('GET')))
  )
  if (kind === undefined) throw new Error(`no Shoppers kind claims ${url}`)
  return Effect.runSync(kind.parse(makeHttpResponse({ url, body: JSON.stringify(payload) })))
}

const customers = (patientIds: readonly string[]): readonly FhirResource[] =>
  extract(customerUrlOf(ACCOUNT_ID), { customer: { patients: patientIds.map((id) => ({ id })) } })

/** The history feed: one fill per id, `fill-<id>`. */
const history = (fillIds: readonly string[]): readonly FhirResource[] =>
  extract(prescriptionHistoryUrlOf(ACCOUNT_ID), {
    dispenses: fillIds.map((id) => ({ prescriptionId: `rx-${id}`, dispenseId: `fill-${id}` })),
  })

/** One prescription's status feed, for `patientId`, with no dispense of its own. */
const prescription = (prescriptionId: string, patientId: string): readonly FhirResource[] =>
  extract(prescriptionStatusUrlOf(prescriptionId), { id: prescriptionId, patientId })

/** `extraction` completed, and the messages the completion logged. */
const complete = (
  extraction: readonly FhirResource[]
): { readonly completed: readonly FhirResource[]; readonly logged: readonly unknown[] } => {
  const logged: unknown[] = []
  const capturingLogger = Logger.make(({ message }) => {
    logged.push(message)
  })
  const completion = Effect.runSync(
    completeShoppersExtraction(extraction).pipe(
      Effect.provide(Logger.replace(Logger.defaultLogger, capturingLogger))
    )
  )
  return { completed: extraction.map(completion), logged }
}

/** Each fill's subject, by the fill's portal `dispenseId`. */
const fillSubjects = (resources: readonly FhirResource[]): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    resources.flatMap((resource) =>
      resource.resourceType === 'MedicationDispense'
        ? [[resource.identifier[0]?.value, resource.subject?.reference ?? null]]
        : []
    )
  )

describe('completeShoppersExtraction', () => {
  it('should file every history fill on the one Patient the extraction holds', () => {
    const [dana] = customers([DANA_ID])

    const { completed, logged } = complete([...customers([DANA_ID]), ...history(['1', '2'])])

    expect(fillSubjects(completed)).toStrictEqual({
      'fill-1': `Patient/${dana?.id}`,
      'fill-2': `Patient/${dana?.id}`,
    })
    expect(logged).toStrictEqual([])
  })

  it("should name the Patient by its adopted source id, as the status feed's subjects are", () => {
    const [request] = prescription('rx-1', DANA_ID)

    const { completed } = complete([...customers([DANA_ID]), ...history(['1'])])

    const [fill] = completed.filter((resource) => resource.resourceType === 'MedicationDispense')
    expect(fill?.resourceType === 'MedicationDispense' && fill.subject).toStrictEqual(
      request?.resourceType === 'MedicationRequest' && request.subject
    )
  })

  it('should leave every history fill of an account managing two people with no subject, even one whose prescription names one, and log the count', () => {
    const extraction = [
      ...customers([DANA_ID, SAM_ID]),
      ...prescription('rx-1', SAM_ID),
      ...history(['1', '2']),
    ]

    const { completed, logged } = complete(extraction)

    expect(fillSubjects(completed)).toStrictEqual({ 'fill-1': null, 'fill-2': null })
    expect(completed.every((resource, index) => resource === extraction[index])).toBe(true)
    expect(logged).toStrictEqual([
      [
        'completeShoppersExtraction: left 2 history fills with no subject (the extraction does not hold exactly one Patient, and an account managing several people is not supported)',
      ],
    ])
  })

  it('should leave a history fill with no subject when the extraction holds no Patient', () => {
    const { completed } = complete(history(['1']))

    expect(fillSubjects(completed)).toStrictEqual({ 'fill-1': null })
  })

  it('should return every resource but a fill with no subject as itself', () => {
    const extraction = [...customers([DANA_ID]), ...prescription('rx-1', DANA_ID)]

    const { completed, logged } = complete(extraction)

    expect(completed.every((resource, index) => resource === extraction[index])).toBe(true)
    expect(logged).toStrictEqual([])
  })
})
