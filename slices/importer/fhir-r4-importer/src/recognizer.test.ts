import { DateTime, Option } from 'effect'
import type { Extraction } from 'importer-fundamentals'
import { describe, expect, it } from 'vite-plus/test'

import { fhirR4Recognizer, fhirRootOf } from './recognizer.ts'

// The properties that generate URLs from a live `InstanceConfig` — and the
// import-vs-live id parity test — live in `fhir-r4-client-collector`'s
// `offline-parity.test.ts`, next to the config they depend on.

const utf8 = new TextEncoder()

/**
 * A minimal {@link Extraction.Input} for the recognizer, which reads only
 * `url` — everything else is filler the shape requires.
 */
const input = (url: string, body = '{}'): Extraction.Input => ({
  id: `req:${url}`,
  url,
  status: 200,
  statusText: 'OK',
  headers: [['content-type', 'application/fhir+json']],
  startedAt: DateTime.unsafeMake('2026-02-02T00:00:00.000Z'),
  body: utf8.encode(body),
  bodyAbsent: false,
})

describe('fhirR4Recognizer', () => {
  it('is a middle-specificity recognizer named fhir-r4', () => {
    expect(fhirR4Recognizer.name).toBe('fhir-r4')
    expect(fhirR4Recognizer.specificity).toBe(50)
  })

  it("claims our own emit shape — the plan's Patient and Observation URLs", () => {
    const root = 'https://r4.example.org/baseR4'
    expect(
      fhirR4Recognizer.claims([
        input(`${root}/Patient/8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882?_format=json`),
        input(`${root}/Observation?subject%3APatient=8c0f46f4&_count=250&_format=json`),
      ])
    ).toBe(true)
  })

  it('claims a Chrome-style HAR capture of a FHIR server amid browser noise', () => {
    // A single FHIR resource URL, interleaved with the fonts/analytics/asset
    // traffic a browser's HAR export carries, is enough to claim.
    expect(
      fhirR4Recognizer.claims([
        input('https://fonts.googleapis.com/css2?family=Inter'),
        input('https://www.google-analytics.com/g/collect?v=2'),
        input('https://ehr.example.com/interconnect-fhir-oauth/api/FHIR/R4/Patient/eXYZ'),
        input('https://ehr.example.com/assets/app.7f3c.js'),
      ])
    ).toBe(true)
  })

  it('claims a single Observation resource and an Observation search', () => {
    const root = 'https://hapi.fhir.org/baseR4'
    expect(fhirR4Recognizer.claims([input(`${root}/Observation/obs-1`)])).toBe(true)
    expect(fhirR4Recognizer.claims([input(`${root}/Observation?patient=1`)])).toBe(true)
  })

  it('declines HTML portal traffic', () => {
    expect(
      fhirR4Recognizer.claims([
        input('https://portal.example.com/carebook/summary', '<!doctype html><html></html>'),
        input('https://portal.example.com/login'),
        input('https://portal.example.com/api/prescriptions'),
      ])
    ).toBe(false)
  })

  it('declines arbitrary JSON APIs', () => {
    expect(
      fhirR4Recognizer.claims([
        input('https://api.example.com/v2/users/1', '{"name":"x"}'),
        input('https://api.github.com/repos/owner/name'),
        input('https://example.com/Patients/1'), // plural — not the FHIR resource
      ])
    ).toBe(false)
  })

  it('declines an empty capture', () => {
    expect(fhirR4Recognizer.claims([])).toBe(false)
  })
})

describe('fhirRootOf', () => {
  it('reads the root off a Patient URL, honoring a base path', () => {
    expect(fhirRootOf('https://r4.example.org/baseR4/Patient/pat-7?_format=json')).toEqual(
      Option.some('https://r4.example.org/baseR4')
    )
  })

  it('reads the root off an Observation resource and an Observation search', () => {
    const root = 'https://hapi.fhir.org/baseR4'
    expect(fhirRootOf(`${root}/Observation/obs-1`)).toEqual(Option.some(root))
    expect(fhirRootOf(`${root}/Observation?subject%3APatient=1&_count=250`)).toEqual(
      Option.some(root)
    )
  })

  it('honors an Epic-style deep base path', () => {
    const root = 'https://ehr.example.com/interconnect-fhir-oauth/api/FHIR/R4'
    expect(fhirRootOf(`${root}/Observation/obs-9`)).toEqual(Option.some(root))
  })

  it('is none for a URL that names no FHIR resource', () => {
    expect(fhirRootOf('https://portal.example.com/login')).toEqual(Option.none())
    expect(fhirRootOf('https://api.example.com/users/1')).toEqual(Option.none())
    expect(fhirRootOf('https://example.com/Patients/1')).toEqual(Option.none())
  })
})
