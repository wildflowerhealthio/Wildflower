import {
  SERVER_QUERY_PARAM,
  serverUrlFromSearch,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { SERVER_URL_EXAMPLE, serverEntryProblem } from './server-target.ts'

/** Absolute `http(s)` URLs, the only inputs the console accepts. */
const httpUrl = fc.webUrl({
  withQueryParameters: true,
  withFragments: true,
  size: 'small',
})

describe('the console target', () => {
  it('is absent when the URL names no usable server, rather than a default', () => {
    expect(serverUrlFromSearch('')).toBeUndefined()
    expect(serverUrlFromSearch('?other=1')).toBeUndefined()
    expect(serverUrlFromSearch(`?${SERVER_QUERY_PARAM}=`)).toBeUndefined()
    expect(serverUrlFromSearch(`?${SERVER_QUERY_PARAM}=javascript:alert(1)`)).toBeUndefined()
  })
})

describe('serverEntryProblem', () => {
  it('accepts any absolute http(s) URL, the example included', () => {
    expect(serverEntryProblem(SERVER_URL_EXAMPLE)).toBeUndefined()
    fc.assert(
      fc.property(httpUrl, (url) => {
        expect(serverEntryProblem(url)).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('says why anything else names no server', () => {
    for (const candidate of ['', 'my-server.example.com', '//host', 'javascript:alert(1)']) {
      expect(serverEntryProblem(candidate)).toBe(
        `Enter a valid http(s) server URL, e.g. ${SERVER_URL_EXAMPLE}.`
      )
    }
  })
})
