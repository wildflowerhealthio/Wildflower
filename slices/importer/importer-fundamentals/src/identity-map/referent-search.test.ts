import { HttpClient, HttpClientRequest, HttpClientResponse, UrlParams } from '@effect/platform'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import { Practitioner, type FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Exit, HashMap, Layer, Option, TestContext } from 'effect'
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
 * that answers every search with `answer`, recording each URL it was asked for.
 */

const TEST_ORIGIN = 'http://fhir.test'
const NAME_BIRTH_DATE = 'https://wildflowerhealth.io/fhir/identifier/patient-name-birth-date'

/** A searchset Bundle carrying `resources`, as the server answers a search. */
const searchset = (resources: readonly object[]): Response =>
  new Response(
    JSON.stringify({
      resourceType: 'Bundle',
      type: 'searchset',
      entry: resources.map((resource) => ({ resource })),
    }),
    { status: 200, headers: { 'content-type': 'application/fhir+json' } }
  )

/** A stub server: the client layer over it, and the URLs it has been asked for. */
interface StubServer {
  readonly layer: Layer.Layer<FhirR4ResourcesHttpApiClient>
  readonly urls: readonly URL[]
}

/** A server that answers every search with `answer`, and the URLs it was asked for. */
const stubServer = (answer: () => Response): StubServer => {
  const urls: URL[] = []
  const httpClient = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
      HttpClient.make((httpRequest) => {
        urls.push(new URL(`${httpRequest.url}?${UrlParams.toString(httpRequest.urlParams)}`))
        return Effect.succeed(HttpClientResponse.fromWeb(httpRequest, answer()))
      }),
      HttpClientRequest.prependUrl(TEST_ORIGIN)
    )
  )
  return { layer: FhirR4ResourcesHttpApiClient.layer.pipe(Layer.provide(httpClient)), urls }
}

/** Search for `referent` against a server answering every search with `stored`. */
const search = async (
  referent: Referent.Type,
  stored: readonly object[] = []
): Promise<{ readonly choice: LinkChoice.Type; readonly urls: readonly URL[] }> => {
  const server = stubServer(() => searchset(stored))
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
    LinkToStoredResource: ({ resource }) =>
      `LinkToStoredResource ${resource.resourceType}/${resource.id}`,
    LinkToDecodedReferent: ({ referentKey }) => `LinkToDecodedReferent ${referentKey}`,
    DontLink: () => 'DontLink',
  })

const TYRA = onlyReferent(patient({ id: 'p-1' }))

describe('ReferentSearch.defaultChoice', () => {
  it('searches the referent’s type once, with every identifier it answers to comma-joined', async () => {
    const { urls } = await search(TYRA)

    expect(urls.map((url) => [url.pathname, url.searchParams.get('identifier')])).toEqual([
      ['/Patient', `${SOURCE_PATIENT}|p-1,${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`],
    ])
  })

  it('asks for the one entry it reads', async () => {
    const { urls } = await search(TYRA)

    expect(urls.map((url) => url.searchParams.get('_count'))).toEqual(['1'])
  })

  it('searches a provider named only by a mention under Practitioner, by its one identity', async () => {
    const prescriber = discoverOnTestClock(
      fileOf(request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith')))
    ).find(({ logicalReference }) => logicalReference.type === 'Practitioner')
    if (prescriber === undefined) throw new Error('expected a prescriber referent')

    const { urls } = await search(prescriber)

    expect(urls.map((url) => [url.pathname, url.searchParams.get('identifier')])).toEqual([
      ['/Practitioner', `${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`],
    ])
  })

  it('gives the referent kind’s default when nothing is found', async () => {
    const account = onlyReferent(request('rx-1', customerSubject('c-9')))

    expect(describeChoice((await search(TYRA)).choice)).toBe('CreateResource')
    expect(describeChoice((await search(account)).choice)).toBe('DontLink')
  })

  it('links to the first resource the search finds', async () => {
    const { choice } = await search(TYRA, [
      { resourceType: 'Patient', id: 's-1' },
      { resourceType: 'Patient', id: 's-2' },
    ])

    expect(describeChoice(choice)).toBe('LinkToStoredResource Patient/s-1')
  })

  it('links a practitioner to a stored practitioner', async () => {
    const { choice, urls } = await search(onlyReferent(practitioner('pr-1', 'Dr. A Smith')), [
      { resourceType: 'Practitioner', id: 'sp-1' },
    ])

    expect(urls[0]?.searchParams.get('identifier')).toBe(
      `${SOURCE_PRACTITIONER}|pr-1,${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`
    )
    expect(describeChoice(choice)).toBe('LinkToStoredResource Practitioner/sp-1')
  })

  it("escapes FHIR search's reserved characters in both halves of a token", async () => {
    const { urls } = await search(
      onlyReferent(
        patient({ id: 'p', system: 'https://a.example/id,$', value: 'a,b|c$d\\e', family: null })
      )
    )

    expect(urls[0]?.searchParams.get('identifier')).toBe(
      'https://a.example/id\\,\\$|a\\,b\\|c\\$d\\\\e'
    )
  })

  it('fails the read when the search fails, rather than reading it as no match', async () => {
    const server = stubServer(() => new Response('', { status: 503 }))

    const exit = await Effect.runPromiseExit(
      ReferentSearch.defaultChoice(TYRA).pipe(Effect.provide(server.layer))
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('ReferentSearch.defaultChoices', () => {
  it('gives every referent its default choice, keyed by referent', async () => {
    const referents = discoverOnTestClock(
      fileOf(patient({ id: 'p-1' }), request('rx-1', customerSubject('c-9')))
    )
    const server = stubServer(() => searchset([{ resourceType: 'Patient', id: 's-1' }]))

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
})
