import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { fetchPatient, fetchPatientPage } from './patients.ts'
import { BundleDecodeError, ResourcePageRequestError } from './resource-page.ts'
import { FhirHttpError, FhirRequestDropped } from './smart-client.ts'
import type { SmartRuntime } from './smart-runtime.ts'
import {
  answerEveryRequest,
  answerStatus,
  dropRequest,
  smartRuntimeAnswering,
  stubSmartRuntime,
  STUB_FHIR_BASE,
  type StubAnswer,
} from './test-helpers.ts'

/** A searchset bundle wrapping `resources`, with no `next` link. */
const bundle = (resources: readonly unknown[]): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource })),
  link: [{ relation: 'self', url: 'https://fhir.example/Patient' }],
})

const patientWire = (id: string): unknown => ({ resourceType: 'Patient', id })

/** A runtime whose server answers every request with `answer`. */
const failingRuntime = (answer: StubAnswer): SmartRuntime =>
  stubSmartRuntime(answerEveryRequest(answer)).runtime

describe('fetchPatientPage', () => {
  test('opens the picker sorted by family name, 200 to a page', async () => {
    const { runtime, urls } = smartRuntimeAnswering(bundle([]))

    await Effect.runPromise(
      fetchPatientPage({ first: null }).pipe(Effect.provide(runtime.runtimeLayer))
    )

    expect(urls).toEqual([`${STUB_FHIR_BASE}/Patient?_sort=family&_count=200`])
  })

  test('requests a later page by its cursor URL verbatim', async () => {
    const { runtime, urls } = smartRuntimeAnswering(bundle([]))
    const pageUrl = 'https://fhir.example/Patient?_getpages=abc&_getpagesoffset=200'

    await Effect.runPromise(
      fetchPatientPage({ pageUrl }).pipe(Effect.provide(runtime.runtimeLayer))
    )

    expect(urls).toEqual([pageUrl])
  })

  test('decodes returned patients and drops undecodable entries', async () => {
    const { runtime } = smartRuntimeAnswering(bundle([{ malformed: true }, patientWire('pat-1')]))

    const page = await Effect.runPromise(
      fetchPatientPage({ first: null }).pipe(Effect.provide(runtime.runtimeLayer))
    )

    expect(page.items.map((item) => item.id)).toEqual(['pat-1'])
    expect(page.nextPageUrl).toBeNull()
    expect(page.droppedEntryCount).toBe(1)
  })
})

describe('fetchPatient', () => {
  test('reads the patient by id and returns it decoded', async () => {
    const { runtime, urls } = smartRuntimeAnswering(patientWire('pat-1'))

    const patient = await Effect.runPromise(
      fetchPatient('pat-1').pipe(Effect.provide(runtime.runtimeLayer))
    )

    expect(urls).toEqual([`${STUB_FHIR_BASE}/Patient/pat-1`])
    expect(Option.map(patient, ({ id }) => id)).toEqual(Option.some('pat-1'))
  })

  test('fails the read when the answer does not decode as a Patient', async () => {
    const answer = { resourceType: 'Observation', id: 'obs-1', code: {} }
    const { runtime } = smartRuntimeAnswering(answer)

    const failure = await Effect.runPromise(
      Effect.flip(fetchPatient('pat-1').pipe(Effect.provide(runtime.runtimeLayer)))
    )

    expect(failure).toBeInstanceOf(BundleDecodeError)
    expect(failure instanceof BundleDecodeError ? failure.response : null).toEqual(answer)
  })

  test.each([404, 410])('reads no patient when the server answers %i', async (status) => {
    const runtime = failingRuntime(answerStatus(status))

    expect(
      await Effect.runPromise(fetchPatient('pat-1').pipe(Effect.provide(runtime.runtimeLayer)))
    ).toEqual(Option.none())
  })

  test.each([
    { case: 'another HTTP status', answer: answerStatus(500), failure: FhirHttpError },
    { case: 'no response at all', answer: dropRequest, failure: FhirRequestDropped },
  ])('fails the read on $case', async ({ answer, failure: expectedCause }) => {
    const failure = await failingRuntime(answer).runSmart(Effect.flip(fetchPatient('p')))

    expect(failure).toBeInstanceOf(ResourcePageRequestError)
    expect(failure.cause).toBeInstanceOf(expectedCause)
    expect(failure.cause).toMatchObject({ url: `${STUB_FHIR_BASE}/Patient/p` })
  })

  test('property: any patient id survives the read path as itself', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (id) => {
        const { runtime, urls } = smartRuntimeAnswering(patientWire('pat-1'))

        await Effect.runPromise(fetchPatient(id).pipe(Effect.provide(runtime.runtimeLayer)))

        // Parsed back rather than string-compared: an id carrying `/`, `?` or a
        // space must stay one path segment instead of reshaping the request.
        const [url = ''] = urls
        const patientPath = `${STUB_FHIR_BASE}/Patient/`
        expect(url.startsWith(patientPath)).toBe(true)
        expect(decodeURIComponent(url.slice(patientPath.length))).toBe(id)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
