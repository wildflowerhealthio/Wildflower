import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'
import { makeHostRedactor } from './redact-hosts.ts'

describe('makeHostRedactor', () => {
  test.each([
    {
      case: 'a relay tunnel in a script URL, keeping its path and file name',
      text: 'https://android-emu.relay.wildflowerhealth.io/assets/index-BfXk2c1a.js',
      redacted: 'https://{host}/assets/index-BfXk2c1a.js',
    },
    {
      case: 'a relay tunnel nested deeper, in any case, with a port',
      text: 'GET https://A.B.Relay.WildflowerHealth.IO:8443/fhir failed',
      redacted: 'GET https://{host}/fhir failed',
    },
    {
      case: 'a relay tunnel at the end of a sentence',
      text: 'Could not reach ruth.relay.wildflowerhealth.io.',
      redacted: 'Could not reach {host}.',
    },
  ])('replaces $case with no hosts to redact', ({ text, redacted }) => {
    expect(makeHostRedactor([])(text)).toBe(redacted)
  })

  test.each([
    'relay.wildflowerhealth.io',
    'https://wildflowerhealth.io/launcher/',
    'http://tauri.localhost/assets/index.js',
    'http://localhost:5173/src/main.tsx',
    'ruth.relay.wildflowerhealth.io.example.org',
  ])('leaves %s as written', (text) => {
    expect(makeHostRedactor([])(text)).toBe(text)
  })

  test.each([
    {
      case: 'the host as written',
      text: 'Failed to fetch ruth.example',
      redacted: 'Failed to fetch {host}',
    },
    {
      case: 'the host with another port',
      text: 'https://ruth.example:9999/fhir/Patient',
      redacted: 'https://{host}/fhir/Patient',
    },
    {
      case: 'the host in another case',
      text: 'https://RUTH.Example/assets/index.js',
      redacted: 'https://{host}/assets/index.js',
    },
    {
      case: 'a subdomain of the host',
      text: 'https://api.ruth.example/r4',
      redacted: 'https://{host}/r4',
    },
    {
      case: 'the host registered by its origin',
      text: 'at https://fhir.example:8443/r4',
      redacted: 'at https://{host}/r4',
    },
  ])('replaces $case', ({ text, redacted }) => {
    expect(makeHostRedactor(['ruth.example:8443', 'https://fhir.example:8443'])(text)).toBe(
      redacted
    )
  })

  test.each(['xruth.example', 'ruth.example.org', 'xruth.example.org', 'ruth-example'])(
    'leaves %s, which only contains the host to redact, as written',
    (text) => {
      expect(makeHostRedactor(['ruth.example'])(text)).toBe(text)
    }
  )

  test('tries the longer host first', () => {
    const redactHosts = makeHostRedactor(['example', 'ruth.example'])

    expect(redactHosts('ruth.example:8443 and example')).toBe('{host} and {host}')
  })

  test('ignores kept hosts and input it cannot read as a host', () => {
    const redactHosts = makeHostRedactor(['localhost:8080', 'wildflowerhealth.io', '', 'a b'])

    expect(redactHosts('localhost:8080 wildflowerhealth.io a b')).toBe(
      'localhost:8080 wildflowerhealth.io a b'
    )
  })

  test('escapes the host it is given', () => {
    expect(makeHostRedactor(['ruth.example'])('ruthxexample')).toBe('ruthxexample')
  })

  test('property: redacting twice is the same as redacting once', () => {
    fc.assert(
      fc.property(fc.domain(), fc.string(), fc.string(), (host, before, after) => {
        const redactHosts = makeHostRedactor([host])
        const redacted = redactHosts(`${before} https://${host}/x ${after}`)

        expect(redacted).toContain('https://{host}/x')
        expect(redactHosts(redacted)).toBe(redacted)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
