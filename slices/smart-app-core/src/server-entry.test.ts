import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Either } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { MENU_COPY, RELAY_NAME_PROBLEM } from './connect-copy.ts'
import { serverUrlForFreeEntry, serverUrlForRelayEntry } from './server-entry.ts'
import { RELAY_DOMAIN } from './server-presets.ts'

/** Absolute `http(s)` URLs, which the free entry accepts. */
const httpUrl = fc.webUrl({
  withQueryParameters: true,
  withFragments: true,
  size: 'small',
})

describe('serverUrlForRelayEntry', () => {
  it('names the relayed server’s origin, trimmed and lower-cased', () => {
    expect(serverUrlForRelayEntry(' My-Server ')).toEqual(
      Either.right(`https://my-server${RELAY_DOMAIN}`)
    )
  })

  it('gives the relay problem for anything but one DNS label', () => {
    for (const candidate of ['', '-ruth', 'ruth-', 'medication.ruth', 'ruth/x', 'a@b']) {
      expect(serverUrlForRelayEntry(candidate)).toEqual(Either.left(RELAY_NAME_PROBLEM))
    }
  })
})

describe('serverUrlForFreeEntry', () => {
  it('accepts any absolute http(s) URL, each menu’s placeholder included', () => {
    for (const target of ['fhir-r4', 'wildflower'] as const) {
      const placeholder = MENU_COPY[target].freeEntryPlaceholder
      expect(Either.isRight(serverUrlForFreeEntry(placeholder, target))).toBe(true)
    }
    fc.assert(
      fc.property(httpUrl, (url) => {
        expect(Either.isRight(serverUrlForFreeEntry(url, 'wildflower'))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('gives its normalized URL', () => {
    expect(serverUrlForFreeEntry(' https://Server.Example.com/ ', 'fhir-r4')).toEqual(
      Either.right('https://server.example.com')
    )
  })

  it('gives the target menu’s invalid-entry message for anything else', () => {
    for (const candidate of ['', 'my-server.example.com', '//host', 'javascript:alert(1)']) {
      expect(serverUrlForFreeEntry(candidate, 'wildflower')).toEqual(
        Either.left(MENU_COPY.wildflower.invalidFreeEntry)
      )
      expect(serverUrlForFreeEntry(candidate, 'fhir-r4')).toEqual(
        Either.left(MENU_COPY['fhir-r4'].invalidFreeEntry)
      )
    }
  })
})
