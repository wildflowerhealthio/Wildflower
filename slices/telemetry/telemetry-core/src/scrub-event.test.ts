import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'
import { anonymizeHost, anonymizeUrl } from './anonymize-url.ts'
import { makeHostRedactor } from './redact-hosts.ts'
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
const ANONYMIZED_FHIR_URL = 'https://{host}/r4/Patient/{id}/_history/{vid}'
const ANONYMIZED_FHIR_PATH = '/r4/Patient/{id}/_history/{vid}'

/** Whether `text` ends in punctuation prose can follow a URL with. */
const endsInPunctuation = (text: string): boolean => /[)>\]"'`.,;:!]$/.test(text)

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
            'server.address': 'https://{host}',
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

  test('reduces a relay-hosted server page and its requests to their shape', () => {
    const pageUrl = 'http://tauri.localhost/servers/android-emu.relay.wildflowerhealth.io'
    const event = {
      transaction: '/servers/android-emu.relay.wildflowerhealth.io',
      breadcrumbs: [
        {
          category: 'navigation',
          data: { from: '/servers', to: '/servers/android-emu.relay.wildflowerhealth.io' },
        },
        { category: 'navigation', data: { from: pageUrl, to: 'http://tauri.localhost/' } },
      ],
      spans: [
        {
          op: 'http.client',
          description:
            'GET https://android-emu.relay.wildflowerhealth.io/fhir/Patient/8a1f2b3c/$everything',
          data: {
            url: 'https://android-emu.relay.wildflowerhealth.io/fhir/Patient/8a1f2b3c/$everything',
            'server.address': 'android-emu.relay.wildflowerhealth.io',
            'url.domain': 'android-emu.relay.wildflowerhealth.io',
          },
        },
        {
          op: 'http.client',
          description: 'http.client GET',
          data: { 'server.address': 'https://ruth.example:8443', 'server.port': 8443 },
        },
      ],
    }

    expect(scrubEvent(event)).toStrictEqual({
      transaction: '/servers/{id}',
      breadcrumbs: [
        { category: 'navigation', data: { from: '/servers', to: '/servers/{id}' } },
        {
          category: 'navigation',
          data: { from: 'http://tauri.localhost/servers/{id}', to: 'http://tauri.localhost/' },
        },
      ],
      spans: [
        {
          op: 'http.client',
          description: 'GET https://{host}/fhir/Patient/{id}/$everything',
          data: {
            url: 'https://{host}/fhir/Patient/{id}/$everything',
            'server.address': '{host}',
            'url.domain': '{host}',
          },
        },
        {
          op: 'http.client',
          description: 'http.client GET',
          data: { 'server.address': 'https://{host}', 'server.port': 8443 },
        },
      ],
    })
  })

  test('reports the script a long animation frame span blames as a stack frame does', () => {
    const scriptUrl = 'https://ruth.relay.wildflowerhealth.io/assets/index-BfXk2c1a.js?v=1#top'
    const event = {
      spans: [
        {
          op: 'ui.long-animation-frame',
          description: 'Main UI thread blocked',
          data: {
            'browser.script.invoker': scriptUrl,
            'browser.script.invoker_type': 'classic-script',
            'code.filepath': scriptUrl,
            'code.function': 'render',
          },
        },
      ],
    }

    expect(scrubEvent(event)).toStrictEqual({
      spans: [
        {
          op: 'ui.long-animation-frame',
          description: 'Main UI thread blocked',
          data: {
            'browser.script.invoker': 'https://{host}/assets/index-BfXk2c1a.js',
            'browser.script.invoker_type': 'classic-script',
            'code.filepath': 'https://{host}/assets/index-BfXk2c1a.js',
            'code.function': 'render',
          },
        },
      ],
    })
  })

  test('keeps the name of what ran a script, and anonymizes a script URL of another scheme', () => {
    const event = {
      spans: [
        { data: { 'browser.script.invoker': 'IMG#avatar.onload' } },
        { data: { 'code.filepath': 'blob:https://ruth.example/0b7c3a2e-1f4d' } },
      ],
    }

    expect(scrubEvent(event)).toStrictEqual({
      spans: [
        { data: { 'browser.script.invoker': 'IMG#avatar.onload' } },
        { data: { 'code.filepath': '{invalid-url}' } },
      ],
    })
  })

  test('replaces only the host in a stack frame’s script URL, and in its debug image alike', () => {
    const relayScript = 'https://android-emu.relay.wildflowerhealth.io/assets/index-BfXk2c1a.js'
    const serverScript = 'https://Ruth.Example:8443/assets/vendor-9a8b7c.js'
    const event = {
      exception: {
        values: [
          {
            type: 'TypeError',
            stacktrace: {
              frames: [
                { filename: relayScript, function: 'render', lineno: 1, colno: 2 },
                { filename: serverScript, abs_path: serverScript, module: serverScript },
                { filename: 'http://tauri.localhost/assets/index-1.js' },
                { filename: 'https://xruth.example.org/a.js' },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [
          { type: 'sourcemap', code_file: relayScript, debug_id: 'd1' },
          { type: 'sourcemap', code_file: serverScript, debug_id: 'd2' },
        ],
      },
    }

    expect(scrubEvent(event, makeHostRedactor(['ruth.example']))).toStrictEqual({
      exception: {
        values: [
          {
            type: 'TypeError',
            stacktrace: {
              frames: [
                {
                  filename: 'https://{host}/assets/index-BfXk2c1a.js',
                  function: 'render',
                  lineno: 1,
                  colno: 2,
                },
                {
                  filename: 'https://{host}/assets/vendor-9a8b7c.js',
                  abs_path: 'https://{host}/assets/vendor-9a8b7c.js',
                  module: 'https://{host}/assets/vendor-9a8b7c.js',
                },
                { filename: 'http://tauri.localhost/assets/index-1.js' },
                { filename: 'https://xruth.example.org/a.js' },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [
          {
            type: 'sourcemap',
            code_file: 'https://{host}/assets/index-BfXk2c1a.js',
            debug_id: 'd1',
          },
          {
            type: 'sourcemap',
            code_file: 'https://{host}/assets/vendor-9a8b7c.js',
            debug_id: 'd2',
          },
        ],
      },
    })
  })

  test('scrubs the free text an error event carries, and replaces server hosts in the rest', () => {
    const event = {
      message: 'Could not reach Ruth.Example:8443',
      logentry: {
        message: 'GET %s failed on %s',
        params: ['https://ruth.example/fhir/Patient/123', 'lab.relay.wildflowerhealth.io', 3],
      },
      exception: {
        values: [
          {
            type: 'TypeError',
            value:
              'Failed to fetch dynamically imported module: https://android-emu.relay.wildflowerhealth.io/assets/Chart-abc.js',
          },
          {
            type: 'Error',
            value: 'ruth.example refused api.ruth.example; xruth.example.org is fine',
          },
        ],
      },
      breadcrumbs: [
        {
          category: 'console',
          message: 'connecting to ruth.example/fhir/Patient/123',
          data: { arguments: ['connecting to', { server: 'RUTH.EXAMPLE' }], logger: 'console' },
        },
      ],
      tags: { app: 'launcher-web', server: 'ruth.example', attempts: 2 },
      extra: { componentStack: '\n    at Chart (https://ruth.example/assets/index-abc.js:1:2)' },
      contexts: { react: { componentStack: 'at App (https://ruth.example/assets/a.js:3:4)' } },
    }

    expect(scrubEvent(event, makeHostRedactor(['ruth.example']))).toStrictEqual({
      message: 'Could not reach {host}',
      logentry: {
        message: 'GET %s failed on %s',
        params: ['https://{host}/fhir/Patient/{id}', '{host}', 3],
      },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'Failed to fetch dynamically imported module: https://{host}/assets/{id}',
          },
          { type: 'Error', value: '{host} refused {host}; xruth.example.org is fine' },
        ],
      },
      breadcrumbs: [
        {
          category: 'console',
          message: 'connecting to {id}/fhir/Patient/{id}',
          data: { arguments: ['connecting to', { server: '{host}' }], logger: 'console' },
        },
      ],
      tags: { app: 'launcher-web', server: '{host}', attempts: 2 },
      extra: { componentStack: '\n    at Chart (https://{host}/assets/index-abc.js:1:2)' },
      contexts: { react: { componentStack: 'at App (https://{host}/assets/a.js:3:4)' } },
    })
  })

  test('replaces server hosts in the keys of breadcrumb data, span data, tags, extra and contexts', () => {
    const event = {
      breadcrumbs: [
        {
          category: 'console',
          data: { arguments: [{ 'ruth.example': 'running', other: ['ruth.example'] }] },
        },
      ],
      spans: [{ data: { 'ruth.example.status': 'up', 'url.full': 'https://ruth.example/r4' } }],
      tags: { 'lab.relay.wildflowerhealth.io': 'up' },
      extra: { 'Ruth.Example:8443': { 'api.ruth.example': 1 } },
      contexts: { 'ruth.example': { state: 'stopped' } },
    }

    expect(scrubEvent(event, makeHostRedactor(['ruth.example']))).toStrictEqual({
      breadcrumbs: [
        {
          category: 'console',
          data: { arguments: [{ '{host}': 'running', other: ['{host}'] }] },
        },
      ],
      spans: [{ data: { '{host}.status': 'up', 'url.full': 'https://{host}/r4' } }],
      tags: { '{host}': 'up' },
      extra: { '{host}': { '{host}': 1 } },
      contexts: { '{host}': { state: 'stopped' } },
    })
  })

  test('replaces server hosts left in span descriptions, span data and the transaction name', () => {
    const event = {
      transaction: 'connect ruth.example',
      contexts: { trace: { description: 'boot ruth.relay.wildflowerhealth.io', data: {} } },
      spans: [
        {
          description: 'resolve ruth.example:8443',
          data: { 'rpc.service': 'ruth.example', 'url.full': 'https://ruth.example/r4' },
        },
      ],
    }

    expect(scrubEvent(event, makeHostRedactor(['https://ruth.example:8443']))).toStrictEqual({
      transaction: 'connect {host}',
      contexts: { trace: { description: 'boot {host}', data: {} } },
      spans: [
        {
          description: 'resolve {host}',
          data: { 'rpc.service': '{host}', 'url.full': 'https://{host}/r4' },
        },
      ],
    })
  })

  test('property: a server host is replaced wherever it stands, and scrubbing again changes nothing', () => {
    fc.assert(
      fc.property(fc.domain(), (host) => {
        const event = {
          message: `lost ${host}`,
          exception: {
            values: [
              {
                value: `${host.toUpperCase()}:8443 timed out`,
                stacktrace: { frames: [{ filename: `https://${host}/assets/index-abc.js` }] },
              },
            ],
          },
          breadcrumbs: [{ message: `retry ${host}.` }],
        }

        const scrubbed = scrubEvent(event, makeHostRedactor([host]))

        expect(scrubbed).toStrictEqual({
          message: 'lost {host}',
          exception: {
            values: [
              {
                value: '{host} timed out',
                stacktrace: { frames: [{ filename: 'https://{host}/assets/index-abc.js' }] },
              },
            ],
          },
          breadcrumbs: [{ message: 'retry {host}.' }],
        })
        expect(scrubEvent(scrubbed, makeHostRedactor([host]))).toStrictEqual(scrubbed)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('keeps a kept host in a host attribute', () => {
    const event = {
      spans: [
        { data: { 'server.address': 'localhost:5173', 'url.domain': 'wildflowerhealth.io' } },
      ],
    }

    expect(scrubEvent(event)).toStrictEqual(event)
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
      fc.property(
        // A span description and a transaction name are prose too, and a URL
        // or path ending in punctuation reads as one followed by it (see
        // anonymizeUrlsInText's tests).
        fc
          .webUrl({ withQueryParameters: true, withFragments: true })
          .filter((url) => !endsInPunctuation(url) && !endsInPunctuation(new URL(url).pathname)),
        (url) => {
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
          expect(transactionEvent.spans[1]?.data['server.address']).toBe(
            anonymizeHost(new URL(url).origin)
          )
        }
      ),
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
