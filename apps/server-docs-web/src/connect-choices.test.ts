import {
  SERVER_QUERY_PARAM,
  searchWithServerUrl,
  serverUrlFromSearch,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import {
  MENU_COPY,
  RELAY_DOMAIN,
  RELAY_GROUP_NAME,
  RELAY_NAME_PROBLEM,
} from '@wildflowerhealthio/smart-app-core'
import { Either } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  CONNECT_CHOICES,
  serverUrlForFreeEntry,
  serverUrlForRelayEntry,
} from './connect-choices.ts'

/** Absolute `http(s)` URLs, which the free entry accepts. */
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

describe('CONNECT_CHOICES', () => {
  it('offers the relay entry, the free entry, then launching without a server', () => {
    expect(CONNECT_CHOICES.map((choice) => [choice.kind, choice.name])).toEqual([
      ['server-entry', RELAY_GROUP_NAME],
      ['server-entry', MENU_COPY.wildflower.freeEntryName],
      ['without-server', 'Without a server'],
    ])
    expect(CONNECT_CHOICES.at(-1)).toMatchObject({ buttonLabel: 'Launch without a server' })
  })

  it('validates each entry with its own rule', () => {
    const [relay, free] = CONNECT_CHOICES
    expect(relay).toMatchObject({ serverUrlFor: serverUrlForRelayEntry })
    expect(free).toMatchObject({ serverUrlFor: serverUrlForFreeEntry })
  })

  it('leaves out the demo-server presets', () => {
    expect(CONNECT_CHOICES).toHaveLength(3)
  })
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
  it('accepts any absolute http(s) URL, the placeholder included', () => {
    expect(Either.isRight(serverUrlForFreeEntry(MENU_COPY.wildflower.freeEntryPlaceholder))).toBe(
      true
    )
    fc.assert(
      fc.property(httpUrl, (url) => {
        expect(Either.isRight(serverUrlForFreeEntry(url))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('gives its normalized URL', () => {
    expect(serverUrlForFreeEntry(' https://Server.Example.com/ ')).toEqual(
      Either.right('https://server.example.com')
    )
  })

  it('gives the invalid-entry message for anything else', () => {
    for (const candidate of ['', 'my-server.example.com', '//host', 'javascript:alert(1)']) {
      expect(serverUrlForFreeEntry(candidate)).toEqual(
        Either.left(MENU_COPY.wildflower.invalidFreeEntry)
      )
    }
  })
})

describe('writing an entry’s server into the URL', () => {
  it('sets ?server= to the server the entry names', () => {
    const relayUrl = Either.getOrThrow(serverUrlForRelayEntry('ruth'))
    expect(searchWithServerUrl('', relayUrl)).toBe(
      `?${SERVER_QUERY_PARAM}=${encodeURIComponent(`https://ruth${RELAY_DOMAIN}`)}`
    )
    const freeUrl = Either.getOrThrow(serverUrlForFreeEntry('http://127.0.0.1:8080'))
    const search = searchWithServerUrl('?other=1', freeUrl)
    expect(new URLSearchParams(search).get('other')).toBe('1')
    expect(serverUrlFromSearch(search)).toBe('http://127.0.0.1:8080')
  })
})
