import { describe, expect, it } from 'vite-plus/test'

import { consoleConfiguration } from './configuration.ts'
import { docSources } from './sources.ts'
import { BEARER_SCHEME_NAME } from './spec.ts'

const configuration = consoleConfiguration('https://example-tunnel-origin', {
  prefersDarkMode: false,
})

describe('consoleConfiguration', () => {
  it('never routes a reader request through a third-party proxy', () => {
    // Scalar's `web` layout defaults to https://proxy.scalar.com, which would
    // forward the request — bearer token included — to a service we don't run,
    // and could never reach a loopback server.
    expect(configuration.proxyUrl).toBe('')
  })

  it('loads no remote fonts and no hosted assistant', () => {
    expect(configuration.withDefaultFonts).toBe(false)
    for (const source of configuration.sources) {
      expect(source.agent).toEqual({ disabled: true })
    }
  })

  it('renders one source per documented slice, in the host order, first one open', () => {
    expect(configuration.sources.map((source) => source.title)).toEqual([
      'Gatekeeper',
      'Apps',
      'Databases',
      'Collector',
      'Tunnel',
      'FHIR R4',
    ])
    expect(configuration.sources.map((source) => source.slug)).toEqual(
      docSources.map((source) => source.slug)
    )
    expect(configuration.sources.map((source) => source.default)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ])
  })

  it('targets every source at the chosen server with a bearer field offered', () => {
    for (const source of configuration.sources) {
      expect(source.content.servers).toEqual([{ url: 'https://example-tunnel-origin' }])
      expect(source.content.security).toEqual([{ [BEARER_SCHEME_NAME]: [] }])
    }
  })

  it('follows the reader’s colour-scheme preference', () => {
    expect(consoleConfiguration('http://127.0.0.1:8080', { prefersDarkMode: true }).darkMode).toBe(
      true
    )
  })
})
