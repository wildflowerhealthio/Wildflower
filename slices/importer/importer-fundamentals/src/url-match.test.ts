import { describe, expect, it } from 'vite-plus/test'

import * as UrlMatch from './url-match.ts'

describe('UrlMatch.make', () => {
  describe('single literal + id segment (Patient/:id)', () => {
    const PatientUrl = UrlMatch.make({ segments: [UrlMatch.literal('Patient'), UrlMatch.id] })

    it.each([
      { url: 'https://r4.smarthealthit.org/Patient/123', match: true },
      { url: 'https://example.com/Patient/abc', match: true },
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
    ])('returns $match for "$url"', ({ url, match }) => {
      expect(PatientUrl.test(url)).toBe(match)
    })
  })

  describe('mustHaveQuery boundary (Observation list)', () => {
    const ObservationList = UrlMatch.make({
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
    ])('returns $match for "$url"', ({ url, match }) => {
      expect(ObservationList.test(url)).toBe(match)
    })
  })

  it('escapes regex metacharacters in literal segments', () => {
    const Quirky = UrlMatch.make({
      segments: [UrlMatch.literal('a.b'), UrlMatch.literal('c+d')],
    })
    expect(Quirky.test('https://example.com/a.b/c+d')).toBe(true)
    // `.` and `+` should NOT match arbitrary characters — they're escaped.
    expect(Quirky.test('https://example.com/aXb/c+d')).toBe(false)
    expect(Quirky.test('https://example.com/a.b/cd')).toBe(false)
  })

  it('requires a scheme://host prefix', () => {
    const PatientUrl = UrlMatch.make({ segments: [UrlMatch.literal('Patient'), UrlMatch.id] })
    expect(PatientUrl.test('/Patient/123')).toBe(false)
    expect(PatientUrl.test('Patient/123')).toBe(false)
  })
})
