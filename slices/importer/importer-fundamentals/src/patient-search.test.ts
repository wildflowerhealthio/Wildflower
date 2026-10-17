import { HttpClient, HttpClientRequest, HttpClientResponse, UrlParams } from '@effect/platform'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Layer, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as PatientSearch from './patient-search.ts'

/**
 * Drives `findPatientByIdentifier` over the typed FHIR client and a stub
 * `HttpClient` that answers each `Patient` search from a table keyed by its
 * `identifier` token, recording every URL it was asked for.
 */

const TEST_ORIGIN = 'http://fhir.test'
const SID = 'https://wildflowerhealth.io/fhir/sid/shoppers-drugmart'
const PC_ID_SYSTEM = 'https://mypharmacy.shoppersdrugmart.ca/fhir/identifier/pc-id'
const PATIENT_ID_SYSTEM = 'https://mypharmacy.shoppersdrugmart.ca/fhir/identifier/patient-id'

const decodePatient = Schema.decodeUnknownSync(Patient.Schema)

/** A searchset Bundle carrying `patients`, as the server answers a search. */
const searchset = (patients: readonly object[]): Response =>
  new Response(
    JSON.stringify({
      resourceType: 'Bundle',
      type: 'searchset',
      entry: patients.map((resource) => ({ resource })),
    }),
    { status: 200, headers: { 'content-type': 'application/fhir+json' } }
  )

/**
 * Run a search for `sourcePatient` against a server that holds `stored`, one
 * Patient per `identifier` token, and record every request URL.
 */
const search = async (
  sourcePatient: Patient.Type,
  stored: ReadonlyMap<string, object> = new Map()
): Promise<{ readonly found: Option.Option<string>; readonly urls: readonly URL[] }> => {
  const urls: URL[] = []
  const httpClient = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
      HttpClient.make((request) => {
        const url = new URL(`${request.url}?${UrlParams.toString(request.urlParams)}`)
        urls.push(url)
        const hit = stored.get(url.searchParams.get('identifier') ?? '')
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, searchset(hit === undefined ? [] : [hit]))
        )
      }),
      HttpClientRequest.prependUrl(TEST_ORIGIN)
    )
  )
  const found = await Effect.runPromise(
    PatientSearch.findPatientByIdentifier(sourcePatient).pipe(
      Effect.map(Option.map((person) => person.id)),
      Effect.provide(FhirR4ResourcesHttpApiClient.layer.pipe(Layer.provide(httpClient)))
    )
  )
  return { found, urls }
}

/** A person's demographic Patient as adoption leaves it: its source id first. */
const sourcePerson = decodePatient({
  resourceType: 'Patient',
  id: 'wf-person',
  identifier: [
    { system: SID, value: 'pt-uuid-1' },
    { system: PATIENT_ID_SYSTEM, value: 'pt-uuid-1' },
  ],
})

const storedPerson = (id: string): object => ({ resourceType: 'Patient', id })

describe('PatientSearch.findPatientByIdentifier', () => {
  it('searches Patient with identifier=system|value', async () => {
    const { urls } = await search(sourcePerson)

    expect(urls[0]?.pathname).toBe('/Patient')
    expect(urls[0]?.searchParams.get('identifier')).toBe(`${SID}|pt-uuid-1`)
  })

  it('gives None when no search finds a Patient, after trying every identifier in order', async () => {
    const { found, urls } = await search(sourcePerson)

    expect(found).toEqual(Option.none())
    expect(urls.map((url) => url.searchParams.get('identifier'))).toEqual([
      `${SID}|pt-uuid-1`,
      `${PATIENT_ID_SYSTEM}|pt-uuid-1`,
    ])
  })

  it('takes the first identifier that hits, and searches no further', async () => {
    const { found, urls } = await search(
      sourcePerson,
      new Map([
        [`${SID}|pt-uuid-1`, storedPerson('ada')],
        [`${PATIENT_ID_SYSTEM}|pt-uuid-1`, storedPerson('someone-else')],
      ])
    )

    expect(found).toEqual(Option.some('ada'))
    expect(urls).toHaveLength(1)
  })

  it('falls through to a later identifier when an earlier one finds nothing', async () => {
    const { found } = await search(
      sourcePerson,
      new Map([[`${PATIENT_ID_SYSTEM}|pt-uuid-1`, storedPerson('ada')]])
    )

    expect(found).toEqual(Option.some('ada'))
  })

  it("does not search a household account's PcId, so never matches it into a person", async () => {
    const householdAccount = decodePatient({
      resourceType: 'Patient',
      id: 'wf-acct',
      identifier: [
        { system: SID, value: 'acct' },
        { system: PC_ID_SYSTEM, value: 'acct' },
      ],
      link: [{ other: { reference: 'Patient/wf-person' }, type: 'seealso' }],
    })

    const { found, urls } = await search(
      householdAccount,
      new Map([[`${PC_ID_SYSTEM}|acct`, storedPerson('ada')]])
    )

    expect(found).toEqual(Option.none())
    expect(urls).toEqual([])
  })

  it('does not search an identifier with no system', async () => {
    const { urls } = await search(
      decodePatient({ resourceType: 'Patient', id: 'p', identifier: [{ value: 'bare' }] })
    )

    expect(urls).toEqual([])
  })
})
