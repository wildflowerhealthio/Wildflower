import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type { HttpMethod } from './http-method.ts'
import * as UrlMatch from './url-match.ts'

const GET: Option.Option<HttpMethod> = Option.some('GET')
const POST: Option.Option<HttpMethod> = Option.some('POST')
const NO_METHOD: Option.Option<HttpMethod> = Option.none()

describe('UrlMatch.make', () => {
  describe('recognition — single literal + id segment (Patient/:id)', () => {
    const patientUrl = UrlMatch.make({
      verb: ['GET'],
      segments: [UrlMatch.literal('Patient'), UrlMatch.id],
    })

    it.each([
      { url: 'https://r4.smarthealthit.org/Patient/123', match: true },
      { url: 'https://example.com/Patient/abc', match: true },
      // `http` is accepted as readily as `https`.
      { url: 'http://example.com/Patient/abc', match: true },
      // Query-string boundary: the `?` ends the path.
      { url: 'https://example.com/Patient/abc?_format=json', match: true },
      // Disjoint resources.
      { url: 'https://example.com/Observation/456', match: false },
      // Trailing slash is a path continuation, not a `?` — rejected.
      { url: 'https://example.com/Patient/123/', match: false },
      { url: 'https://example.com/Patient/123/_history', match: false },
      // Empty id (no segment value) is rejected — `[^/?#]+` requires one char.
      { url: 'https://example.com/Patient/?', match: false },
      // Base-path-mounted servers match (issue #376): the declared segments
      // are a suffix of the path, not required directly under the origin root.
      { url: 'https://hapi.fhir.org/baseR4/Patient/123', match: true },
      { url: 'https://host/fhir/R4/Patient/123?_format=json', match: true },
      {
        url: 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/Patient/123',
        match: true,
      },
      // `_history` stays excluded even under a base path.
      { url: 'https://host/fhir/Patient/123/_history', match: false },
      // Authority-vs-segment guard: a host literally named `Patient` is NOT a
      // `/Patient` segment (the greedy `://[^/]+` consumes it as the host).
      { url: 'https://Patient/123', match: false },
      // Scheme required (deliberate tightening): a non-`http(s)` scheme and a
      // scheme-less URL now fail even when the resource segment is present.
      { url: 'ftp://example.com/Patient/123', match: false },
      { url: 'urn:example:Patient/123', match: false },
    ])('recognizes $match for "$url"', ({ url, match }) => {
      expect(Option.isSome(patientUrl(url, GET))).toBe(match)
    })
  })

  describe('verb enforcement', () => {
    const patientUrl = UrlMatch.make({
      verb: ['GET'],
      segments: [UrlMatch.literal('Patient'), UrlMatch.id],
    })

    it('matches when the method is in the declared verb list', () => {
      expect(patientUrl('https://ehr/Patient/1', GET)).toStrictEqual(Option.some('https://ehr'))
    })

    it('rejects a URL whose method is not in the declared verb list', () => {
      expect(patientUrl('https://ehr/Patient/1', POST)).toStrictEqual(Option.none())
    })

    it('rejects a URL whose method is Option.none() (the HAR-UNKNOWN case)', () => {
      expect(patientUrl('https://ehr/Patient/1', NO_METHOD)).toStrictEqual(Option.none())
    })

    it('accepts any of several declared verbs', () => {
      const both = UrlMatch.make({
        verb: ['GET', 'POST'],
        segments: [UrlMatch.literal('Search')],
      })
      expect(Option.isSome(both('https://ehr/Search', GET))).toBe(true)
      expect(Option.isSome(both('https://ehr/Search', POST))).toBe(true)
      expect(Option.isSome(both('https://ehr/Search', Option.some('PUT')))).toBe(false)
      expect(Option.isSome(both('https://ehr/Search', NO_METHOD))).toBe(false)
    })
  })

  describe('recognition — mustHaveQuery boundary (Observation list)', () => {
    const observationList = UrlMatch.make({
      verb: ['GET'],
      segments: [UrlMatch.literal('Observation')],
      end: 'mustHaveQuery',
    })

    it.each([
      { url: 'https://r4.smarthealthit.org/Observation?subject=Patient/1', match: true },
      { url: 'https://r4.smarthealthit.org/Observation?_count=250', match: true },
      // Base path + query matches; single-resource under a base path does not
      // (disjointness survives the base-path group — issue #376).
      { url: 'https://hapi.fhir.org/baseR4/Observation?subject=Patient/1', match: true },
      { url: 'https://hapi.fhir.org/baseR4/Observation/123', match: false },
      // No `?` — fails; the resource-list endpoint is `?…` form only.
      { url: 'https://r4.smarthealthit.org/Observation', match: false },
      { url: 'https://r4.smarthealthit.org/Observation/123', match: false },
    ])('recognizes $match for "$url"', ({ url, match }) => {
      expect(Option.isSome(observationList(url, GET))).toBe(match)
    })
  })

  it('escapes regex metacharacters in literal segments', () => {
    const quirky = UrlMatch.make({
      verb: ['GET'],
      segments: [UrlMatch.literal('a.b'), UrlMatch.literal('c+d')],
    })
    expect(Option.isSome(quirky('https://example.com/a.b/c+d', GET))).toBe(true)
    // `.` and `+` should NOT match arbitrary characters — they're escaped.
    expect(Option.isSome(quirky('https://example.com/aXb/c+d', GET))).toBe(false)
    expect(Option.isSome(quirky('https://example.com/a.b/cd', GET))).toBe(false)
  })

  it('requires a scheme://host prefix', () => {
    const patientUrl = UrlMatch.make({
      verb: ['GET'],
      segments: [UrlMatch.literal('Patient'), UrlMatch.id],
    })
    expect(Option.isSome(patientUrl('/Patient/123', GET))).toBe(false)
    expect(Option.isSome(patientUrl('Patient/123', GET))).toBe(false)
  })

  describe('root capture — the scheme + authority + base-path prefix', () => {
    const patientUrl = UrlMatch.make({
      verb: ['GET'],
      segments: [UrlMatch.literal('Patient'), UrlMatch.id],
    })
    const observationList = UrlMatch.make({
      verb: ['GET'],
      segments: [UrlMatch.literal('Observation')],
      end: 'mustHaveQuery',
    })

    it('recovers the origin root when there is no base path', () => {
      expect(patientUrl('https://ehr/Patient/1', GET)).toStrictEqual(Option.some('https://ehr'))
    })

    it('recovers a single-segment base path (baseR4)', () => {
      expect(patientUrl('https://ehr/baseR4/Patient/1', GET)).toStrictEqual(
        Option.some('https://ehr/baseR4')
      )
    })

    it('recovers a deep base path and stops before the query', () => {
      const observationUrl = UrlMatch.make({
        verb: ['GET'],
        segments: [UrlMatch.literal('Observation'), UrlMatch.id],
      })
      expect(
        observationUrl('https://ehr/interconnect-fhir-oauth/api/FHIR/R4/Observation/2?x=1', GET)
      ).toStrictEqual(Option.some('https://ehr/interconnect-fhir-oauth/api/FHIR/R4'))
    })

    it('is None when the URL names no matching resource', () => {
      expect(patientUrl('https://ehr/Observation/1', GET)).toStrictEqual(Option.none())
    })

    it('is None for a non-http(s) scheme even with the resource segment', () => {
      expect(patientUrl('ftp://ehr/Patient/1', GET)).toStrictEqual(Option.none())
    })

    it('respects mustHaveQuery disjointness — a single resource yields no list root', () => {
      // The single-`Observation` URL must not be re-read as a base path that
      // makes the `mustHaveQuery` list match.
      expect(observationList('https://ehr/Observation/2', GET)).toStrictEqual(Option.none())
      expect(observationList('https://ehr/Observation?x=1', GET)).toStrictEqual(
        Option.some('https://ehr')
      )
    })
  })
})
