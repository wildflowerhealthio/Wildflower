import { HttpClient, HttpClientRequest, HttpClientResponse, UrlParams } from '@effect/platform'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import { Patient, Practitioner, type FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Exit, HashMap, Layer, Option, Schema, TestContext } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  CUSTOMER,
  SOURCE_PATIENT,
  SOURCE_PRACTITIONER,
  customerSubject,
  discoverOnTestClock,
  fileOf,
  namedRequester,
  patient,
  practitioner,
  request,
} from './identity-map.test-helpers.ts'
import * as LinkChoice from './link-choice.ts'
import * as ReferentSearch from './referent-search.ts'
import * as Referent from './referent.ts'

/**
 * Drives `ReferentSearch` over the typed FHIR client and a stub `HttpClient`
 * that answers each search by the `identifier` it asks for, recording each URL
 * it was asked for.
 */

const TEST_ORIGIN = 'http://fhir.test'
const NAME_BIRTH_DATE = 'https://wildflowerhealth.io/fhir/identifier/patient-name-birth-date'
const TYRA_OWN = `${SOURCE_PATIENT}|p-1`
const TYRA_DERIVED = `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`

const STORED_1 = { resourceType: 'Patient', id: 's-1' }
const STORED_2 = { resourceType: 'Patient', id: 's-2' }

/** A searchset Bundle of `entries`, as the server answers a search. */
const searchsetOf = (entries: readonly object[]): Response =>
  new Response(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: entries }), {
    status: 200,
    headers: { 'content-type': 'application/fhir+json' },
  })

/** A searchset Bundle carrying `resources`, one match each. */
const searchset = (resources: readonly object[]): Response =>
  searchsetOf(resources.map((resource) => ({ resource })))

/** A stub server: the client layer over it, and the URLs it has been asked for. */
interface StubServer {
  readonly layer: Layer.Layer<FhirR4ResourcesHttpApiClient>
  readonly urls: readonly URL[]
}

/** A server that answers each search with `answer` of its `identifier` value, and the URLs it was asked for. */
const stubServer = (answer: (identifierSearch: string | null) => Response): StubServer => {
  const urls: URL[] = []
  const httpClient = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
      HttpClient.make((httpRequest) => {
        const url = new URL(`${httpRequest.url}?${UrlParams.toString(httpRequest.urlParams)}`)
        urls.push(url)
        return Effect.succeed(
          HttpClientResponse.fromWeb(httpRequest, answer(url.searchParams.get('identifier')))
        )
      }),
      HttpClientRequest.prependUrl(TEST_ORIGIN)
    )
  )
  return { layer: FhirR4ResourcesHttpApiClient.layer.pipe(Layer.provide(httpClient)), urls }
}

/** A server whose searches find `hitsFor` of the identifier value asked for, nothing otherwise. */
const serverFinding = (hitsFor: Readonly<Record<string, readonly object[]>>): StubServer =>
  stubServer((identifierSearch) =>
    searchset(identifierSearch === null ? [] : (hitsFor[identifierSearch] ?? []))
  )

/** Search for `referent` against `server`. */
const search = async (
  referent: Referent.Type,
  server: StubServer = serverFinding({})
): Promise<{ readonly choice: LinkChoice.Type; readonly urls: readonly URL[] }> => {
  const choice = await Effect.runPromise(
    ReferentSearch.defaultChoice(referent).pipe(
      Effect.provide(Layer.merge(server.layer, TestContext.TestContext))
    )
  )
  return { choice, urls: server.urls }
}

/** The only referent `resources` hold. */
const onlyReferent = (...resources: readonly FhirResource[]): Referent.Type => {
  const [referent, ...rest] = discoverOnTestClock(fileOf(...resources))
  if (referent === undefined || rest.length > 0) throw new Error('expected one referent')
  return referent
}

/** A choice as `<tag> <id>`, the id for one linked to a stored resource. */
const describeChoice = (choice: LinkChoice.Type): string =>
  LinkChoice.match(choice, {
    CreateResource: () => 'CreateResource',
    UpdateStoredResource: ({ resource }) =>
      `UpdateStoredResource ${resource.resourceType}/${resource.id}`,
    LinkToStoredResource: ({ resource }) =>
      `LinkToStoredResource ${resource.resourceType}/${resource.id}`,
    LinkToDecodedReferent: ({ referentKey }) => `LinkToDecodedReferent ${referentKey}`,
    DontLink: () => 'DontLink',
  })

/** The searches `urls` record, as `<path> <identifier value>`. */
const searchesOf = (urls: readonly URL[]): readonly string[] =>
  urls.map((url) => `${url.pathname} ${url.searchParams.get('identifier')}`)

const TYRA = onlyReferent(patient({ id: 'p-1' }))

describe('ReferentSearch.defaultChoice', () => {
  it('should search the referent’s own identifiers first, and the derived one only when they name nothing', async () => {
    const { urls } = await search(TYRA)

    expect(searchesOf(urls)).toEqual([`/Patient ${TYRA_OWN}`, `/Patient ${TYRA_DERIVED}`])
  })

  it('should ask for two entries, so a second hit is seen', async () => {
    const { urls } = await search(TYRA)

    expect(urls.map((url) => url.searchParams.get('_count'))).toEqual(['2', '2'])
  })

  it('should search a provider named only by a mention once, under Practitioner, by its one identity', async () => {
    const prescriber = discoverOnTestClock(
      fileOf(request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith')))
    ).find(({ logicalReference }) => logicalReference.type === 'Practitioner')
    if (prescriber === undefined) throw new Error('expected a prescriber referent')

    const { urls } = await search(prescriber)

    expect(searchesOf(urls)).toEqual([
      `/Practitioner ${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`,
    ])
  })

  it('should give the referent kind’s default when nothing is found', async () => {
    const account = onlyReferent(request('rx-1', customerSubject('c-9')))

    expect(describeChoice((await search(TYRA)).choice)).toBe('CreateResource')
    expect(describeChoice((await search(account)).choice)).toBe('DontLink')
  })

  it('should link to the one resource the own identifiers name, without searching the derived one', async () => {
    const { choice, urls } = await search(TYRA, serverFinding({ [TYRA_OWN]: [STORED_1] }))

    expect(describeChoice(choice)).toBe('LinkToStoredResource Patient/s-1')
    expect(searchesOf(urls)).toEqual([`/Patient ${TYRA_OWN}`])
  })

  it('should link to the one resource the derived identifier names when the own name none', async () => {
    const { choice } = await search(TYRA, serverFinding({ [TYRA_DERIVED]: [STORED_2] }))

    expect(describeChoice(choice)).toBe('LinkToStoredResource Patient/s-2')
  })

  it('should prefer the record the own identifiers name over a namesake the derived one names', async () => {
    const { choice } = await search(
      TYRA,
      serverFinding({ [TYRA_OWN]: [STORED_1], [TYRA_DERIVED]: [STORED_2] })
    )

    expect(describeChoice(choice)).toBe('LinkToStoredResource Patient/s-1')
  })

  it('should pick no default when two stored resources answer one search, and search no further', async () => {
    const { choice, urls } = await search(
      TYRA,
      serverFinding({ [TYRA_OWN]: [STORED_1, STORED_2], [TYRA_DERIVED]: [STORED_2] })
    )

    expect(describeChoice(choice)).toBe('CreateResource')
    expect(searchesOf(urls)).toEqual([`/Patient ${TYRA_OWN}`])
  })

  it('should update the stored copy when the one hit is under the decoded id, so the decode keeps what the copy assumed', async () => {
    const storedCopy = { resourceType: 'Patient', id: 'p-1' }

    expect(
      describeChoice((await search(TYRA, serverFinding({ [TYRA_OWN]: [storedCopy] }))).choice)
    ).toBe('UpdateStoredResource Patient/p-1')
    expect(
      describeChoice((await search(TYRA, serverFinding({ [TYRA_DERIVED]: [storedCopy] }))).choice)
    ).toBe('UpdateStoredResource Patient/p-1')
  })

  it('should update the stored copy even when another record answers the same search', async () => {
    const storedCopy = { resourceType: 'Patient', id: 'p-1' }

    expect(
      describeChoice(
        (await search(TYRA, serverFinding({ [TYRA_OWN]: [STORED_1, storedCopy] }))).choice
      )
    ).toBe('UpdateStoredResource Patient/p-1')
  })

  it('should search a derived identifier the decode already carries only as the derived one', async () => {
    const placedBefore = onlyReferent(
      Schema.decodeUnknownSync(Patient.Schema)({
        resourceType: 'Patient',
        id: 'p-1',
        identifier: [
          { system: SOURCE_PATIENT, value: 'p-1' },
          { system: NAME_BIRTH_DATE, value: 'banks;tyra;1990-01-02' },
        ],
        name: [{ family: 'Banks', given: ['Tyra'] }],
        birthDate: '1990-01-02',
      })
    )

    const { urls } = await search(placedBefore)

    expect(searchesOf(urls)).toEqual([`/Patient ${TYRA_OWN}`, `/Patient ${TYRA_DERIVED}`])
  })

  it('should count a match that carries no resource as a failure, and an outcome entry as nothing', async () => {
    const outcomeOnly = stubServer(() =>
      searchsetOf([{ resource: STORED_1 }, { search: { mode: 'outcome' } }])
    )
    const matchWithoutResource = stubServer(() =>
      searchsetOf([{ resource: STORED_1 }, { search: { mode: 'match' } }])
    )

    expect(describeChoice((await search(TYRA, outcomeOnly)).choice)).toBe(
      'LinkToStoredResource Patient/s-1'
    )
    const exit = await Effect.runPromiseExit(
      ReferentSearch.defaultChoice(TYRA).pipe(
        Effect.provide(Layer.merge(matchWithoutResource.layer, TestContext.TestContext))
      )
    )
    expect(exit).toMatchObject({
      _tag: 'Failure',
      cause: { _tag: 'Fail', error: { _tag: 'MatchWithoutResource', resourceType: 'Patient' } },
    })
  })

  it('should link a practitioner to a stored practitioner', async () => {
    const own = `${SOURCE_PRACTITIONER}|pr-1`
    const { choice, urls } = await search(
      onlyReferent(practitioner('pr-1', 'Dr. A Smith')),
      serverFinding({ [own]: [{ resourceType: 'Practitioner', id: 'sp-1' }] })
    )

    expect(searchesOf(urls)).toEqual([`/Practitioner ${own}`])
    expect(describeChoice(choice)).toBe('LinkToStoredResource Practitioner/sp-1')
  })

  it("should escape FHIR search's reserved characters in both halves of a token", async () => {
    const { urls } = await search(
      onlyReferent(
        patient({ id: 'p', system: 'https://a.example/id,$', value: 'a,b|c$d\\e', family: null })
      )
    )

    expect(urls[0]?.searchParams.get('identifier')).toBe(
      'https://a.example/id\\,\\$|a\\,b\\|c\\$d\\\\e'
    )
  })

  it('should fail the read when the search fails, rather than reading it as no match', async () => {
    const server = stubServer(() => new Response('', { status: 503 }))

    const exit = await Effect.runPromiseExit(
      ReferentSearch.defaultChoice(TYRA).pipe(Effect.provide(server.layer))
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('ReferentSearch.defaultChoices', () => {
  it('should give every referent its default choice, keyed by referent', async () => {
    const referents = discoverOnTestClock(
      fileOf(patient({ id: 'p-1' }), request('rx-1', customerSubject('c-9')))
    )
    const server = serverFinding({ [TYRA_OWN]: [STORED_1], [`${CUSTOMER}|c-9`]: [STORED_1] })

    const choices = await Effect.runPromise(
      ReferentSearch.defaultChoices(referents).pipe(
        Effect.provide(Layer.merge(server.layer, TestContext.TestContext))
      )
    )

    expect(
      referents.map((referent) => [
        Referent.key(referent),
        Option.map(HashMap.get(choices, Referent.key(referent)), describeChoice),
      ])
    ).toEqual([
      [`Patient|${SOURCE_PATIENT}|p-1`, Option.some('LinkToStoredResource Patient/s-1')],
      [`Patient|${CUSTOMER}|c-9`, Option.some('LinkToStoredResource Patient/s-1')],
    ])
    expect(HashMap.size(choices)).toBe(2)
    expect(server.urls).toHaveLength(2)
  })

  it('should update a re-imported person’s stored copy and link the account it assumed to that copy', async () => {
    const referents = discoverOnTestClock(
      fileOf(patient({ id: 'p-1' }), request('rx-1', customerSubject('c-9')))
    )
    const storedCopy = { resourceType: 'Patient', id: 'p-1' }
    const server = serverFinding({ [TYRA_OWN]: [storedCopy], [`${CUSTOMER}|c-9`]: [storedCopy] })

    const choices = await Effect.runPromise(
      ReferentSearch.defaultChoices(referents).pipe(
        Effect.provide(Layer.merge(server.layer, TestContext.TestContext))
      )
    )

    expect(
      referents.map((referent) => [
        Referent.key(referent),
        Option.map(HashMap.get(choices, Referent.key(referent)), describeChoice),
      ])
    ).toEqual([
      [`Patient|${SOURCE_PATIENT}|p-1`, Option.some('UpdateStoredResource Patient/p-1')],
      [`Patient|${CUSTOMER}|c-9`, Option.some('LinkToStoredResource Patient/p-1')],
    ])
  })
})
