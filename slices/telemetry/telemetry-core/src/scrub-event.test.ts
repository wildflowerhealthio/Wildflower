import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'
import { anonymizeUrl } from './anonymize-url.ts'
import { type ScrubbableEvent, scrubEvent } from './scrub-event.ts'

interface SampleBreadcrumb {
  readonly category: string
  readonly type?: string
  readonly message?: string
  readonly data?: Readonly<Record<string, string | number | undefined>>
}

interface SampleSpan {
  readonly span_id: string
  readonly op: string
  readonly description: string
  readonly data: Readonly<Record<string, string | undefined>>
}

interface SampleErrorEvent {
  readonly event_id: string
  readonly message: string
  readonly request: {
    readonly url: string
    readonly query_string: string | undefined
    readonly headers: Readonly<Record<string, string>>
  }
  readonly breadcrumbs: readonly SampleBreadcrumb[]
}

interface SampleTransactionEvent {
  readonly type: 'transaction'
  readonly transaction: string
  readonly request: { readonly url: string }
  readonly contexts: {
    readonly trace: {
      readonly trace_id: string
      readonly span_id: string
      readonly data: Readonly<Record<string, string>>
    }
  }
  readonly spans: readonly SampleSpan[]
}

/**
 * An error event in the shape the Sentry browser SDK hands `beforeSend`, with
 * a URL in every place one is reported.
 */
const errorEventCarrying = (url: string): SampleErrorEvent => ({
  event_id: 'abc123',
  message: 'Failed to load observations',
  request: {
    url,
    query_string: 'patient=123',
    headers: { Referer: url, 'User-Agent': 'Mozilla/5.0' },
  },
  breadcrumbs: [
    { category: 'fetch', type: 'http', data: { method: 'GET', url, status_code: 200 } },
    { category: 'navigation', data: { from: url, to: url } },
    { category: 'console', message: 'no data' },
  ],
})

/**
 * A transaction event in the shape the SDK hands `beforeSendTransaction`: a
 * page load, a Sentry fetch span, and a span from Effect's HTTP client with
 * its request and response headers.
 */
const transactionEventCarrying = (url: string): SampleTransactionEvent => ({
  type: 'transaction',
  transaction: new URL(url).pathname,
  request: { url },
  contexts: {
    trace: {
      trace_id: 't1',
      span_id: 's1',
      data: {
        'url.full': url,
        'url.path': new URL(url).pathname,
        'lcp.url': url,
        'sentry.op': 'pageload',
      },
    },
  },
  spans: [
    {
      span_id: 's2',
      op: 'http.client',
      description: `GET ${url}`,
      data: { 'http.url': url, url, 'url.full': url, 'http.query': '?a=1', 'http.fragment': '#b' },
    },
    {
      span_id: 's3',
      op: 'http.client',
      description: 'http.client GET',
      data: {
        'url.full': url,
        'url.path': new URL(url).pathname,
        'url.query': 'patient=123',
        'http.request.header.accept': 'application/fhir+json',
        'http.response.header.location': url,
        'server.address': new URL(url).origin,
      },
    },
    { span_id: 's4', op: 'ui.long-task', description: 'Main UI thread blocked', data: {} },
  ],
})

const FHIR_URL = 'https://fhir.example/r4/Patient/123/_history/2?_format=json#top'
const ANONYMIZED_FHIR_URL = 'https://fhir.example/r4/Patient/{id}/_history/{vid}'
const ANONYMIZED_FHIR_PATH = '/r4/Patient/{id}/_history/{vid}'

describe('scrubEvent', () => {
  test('anonymizes every URL an error event carries and keeps the rest', () => {
    expect(scrubEvent(errorEventCarrying(FHIR_URL))).toStrictEqual({
      event_id: 'abc123',
      message: 'Failed to load observations',
      request: {
        url: ANONYMIZED_FHIR_URL,
        query_string: undefined,
        headers: { Referer: ANONYMIZED_FHIR_URL, 'User-Agent': 'Mozilla/5.0' },
      },
      breadcrumbs: [
        {
          category: 'fetch',
          type: 'http',
          data: { method: 'GET', url: ANONYMIZED_FHIR_URL, status_code: 200 },
        },
        { category: 'navigation', data: { from: ANONYMIZED_FHIR_URL, to: ANONYMIZED_FHIR_URL } },
        { category: 'console', message: 'no data' },
      ],
    })
  })

  test('anonymizes every URL a transaction event carries and keeps the rest', () => {
    expect(scrubEvent(transactionEventCarrying(FHIR_URL))).toStrictEqual({
      type: 'transaction',
      transaction: ANONYMIZED_FHIR_PATH,
      request: { url: ANONYMIZED_FHIR_URL },
      contexts: {
        trace: {
          trace_id: 't1',
          span_id: 's1',
          data: {
            'url.full': ANONYMIZED_FHIR_URL,
            'url.path': ANONYMIZED_FHIR_PATH,
            'lcp.url': ANONYMIZED_FHIR_URL,
            'sentry.op': 'pageload',
          },
        },
      },
      spans: [
        {
          span_id: 's2',
          op: 'http.client',
          description: `GET ${ANONYMIZED_FHIR_URL}`,
          data: {
            'http.url': ANONYMIZED_FHIR_URL,
            url: ANONYMIZED_FHIR_URL,
            'url.full': ANONYMIZED_FHIR_URL,
            'http.query': undefined,
            'http.fragment': undefined,
          },
        },
        {
          span_id: 's3',
          op: 'http.client',
          description: 'http.client GET',
          data: {
            'url.full': ANONYMIZED_FHIR_URL,
            'url.path': ANONYMIZED_FHIR_PATH,
            'url.query': undefined,
            'http.request.header.accept': undefined,
            'http.response.header.location': undefined,
            'server.address': 'https://fhir.example',
          },
        },
        {
          span_id: 's4',
          op: 'ui.long-task',
          description: 'Main UI thread blocked',
          data: {},
        },
      ],
    })
  })

  test('leaves an event without URL-bearing fields as it was', () => {
    const event: ScrubbableEvent & { readonly message: string } = { message: 'boom' }

    expect(scrubEvent(event)).toStrictEqual(event)
  })

  test('property: does not modify the event it is given', () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        const errorEvent = errorEventCarrying(url)
        const transactionEvent = transactionEventCarrying(url)
        const errorEventBefore = structuredClone(errorEvent)
        const transactionEventBefore = structuredClone(transactionEvent)

        scrubEvent(errorEvent)
        scrubEvent(transactionEvent)

        expect(errorEvent).toStrictEqual(errorEventBefore)
        expect(transactionEvent).toStrictEqual(transactionEventBefore)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  test('property: every reported URL is the anonymized URL', () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        const anonymizedUrl = anonymizeUrl(url)
        const anonymizedPath = anonymizeUrl(new URL(url).pathname)
        const errorEvent = scrubEvent(errorEventCarrying(url))
        const transactionEvent = scrubEvent(transactionEventCarrying(url))

        expect([
          errorEvent.request.url,
          errorEvent.request.headers.Referer,
          errorEvent.breadcrumbs[0]?.data?.url,
          errorEvent.breadcrumbs[1]?.data?.from,
          errorEvent.breadcrumbs[1]?.data?.to,
          transactionEvent.request.url,
          transactionEvent.contexts.trace.data['url.full'],
          transactionEvent.contexts.trace.data['lcp.url'],
          transactionEvent.spans[0]?.data['http.url'],
          transactionEvent.spans[0]?.data.url,
          transactionEvent.spans[0]?.data['url.full'],
          transactionEvent.spans[1]?.data['url.full'],
        ]).toStrictEqual(Array.from({ length: 12 }, () => anonymizedUrl))
        expect([
          transactionEvent.transaction,
          transactionEvent.contexts.trace.data['url.path'],
          transactionEvent.spans[1]?.data['url.path'],
        ]).toStrictEqual(Array.from({ length: 3 }, () => anonymizedPath))
        expect(transactionEvent.spans[0]?.description).toBe(`GET ${anonymizedUrl}`)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: scrubbing twice is the same as scrubbing once', () => {
    fc.assert(
      fc.property(fc.webUrl({ withQueryParameters: true, withFragments: true }), (url) => {
        const scrubbedErrorEvent = scrubEvent(errorEventCarrying(url))
        const scrubbedTransactionEvent = scrubEvent(transactionEventCarrying(url))

        expect(scrubEvent(scrubbedErrorEvent)).toStrictEqual(scrubbedErrorEvent)
        expect(scrubEvent(scrubbedTransactionEvent)).toStrictEqual(scrubbedTransactionEvent)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
