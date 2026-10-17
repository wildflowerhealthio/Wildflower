import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { LaunchUrl, SmartScope, SUGGESTED_APPS_URL, SuggestedApps } from './suggested-apps.ts'

const decodeDocument = Schema.decodeUnknownEither(SuggestedApps)
const decodeLaunchUrl = Schema.decodeUnknownEither(LaunchUrl)
const decodeScope = Schema.decodeUnknownEither(SmartScope)

/** One valid app; each rejection test changes one field of it. */
const app = {
  id: 'growth-chart',
  name: 'SMART Growth Chart',
  description: "Plots a child's height against standard growth curves.",
  launchUrl: 'https://examples.smarthealthit.org/growth-chart-app/launch.html',
  publisher: { kind: 'third-party', name: 'SMART Health IT' },
  tags: ['pediatrics'],
  scopes: ['patient/Observation.read', 'offline_access'],
}

const documentOf = (...apps: readonly object[]): { version: number; apps: readonly object[] } => ({
  version: 1,
  apps,
})

/** Kebab-case slugs: one to three runs of lowercase letters and digits. */
const kebabCaseId = fc
  .array(fc.stringMatching(/^[a-z0-9]{1,6}$/), { minLength: 1, maxLength: 3 })
  .map((runs) => runs.join('-'))

/** `https:` URLs carrying neither `iss` nor `launch`, with paths, queries and fragments. */
const httpsUrl = fc
  .webUrl({ validSchemes: ['https'], withQueryParameters: true, withFragments: true })
  .filter((text) => {
    const { searchParams } = new URL(text)
    return !searchParams.has('iss') && !searchParams.has('launch')
  })

describe('SuggestedApps', () => {
  it('decodes a minimal document', () => {
    expect(decodeDocument(documentOf(app))).toEqual(Either.right(documentOf(app)))
    expect(decodeDocument(documentOf())).toEqual(Either.right(documentOf()))
  })

  it('rejects a version other than 1', () => {
    expect(Either.isLeft(decodeDocument({ version: 2, apps: [app] }))).toBe(true)
  })

  it('rejects a tag outside the closed list', () => {
    expect(Either.isLeft(decodeDocument(documentOf({ ...app, tags: ['genomics'] })))).toBe(true)
  })

  it('rejects an app with no tags or no scopes', () => {
    expect(Either.isLeft(decodeDocument(documentOf({ ...app, tags: [] })))).toBe(true)
    expect(Either.isLeft(decodeDocument(documentOf({ ...app, scopes: [] })))).toBe(true)
  })

  it('rejects an id that is not kebab-case', () => {
    for (const id of ['', 'Growth-Chart', 'growth_chart', '-growth', 'growth--chart', 'growth-']) {
      expect(Either.isLeft(decodeDocument(documentOf({ ...app, id })))).toBe(true)
    }
  })

  it('rejects a blank name, description or publisher name', () => {
    expect(Either.isLeft(decodeDocument(documentOf({ ...app, name: ' ' })))).toBe(true)
    expect(Either.isLeft(decodeDocument(documentOf({ ...app, description: '' })))).toBe(true)
    expect(
      Either.isLeft(
        decodeDocument(documentOf({ ...app, publisher: { kind: 'first-party', name: '' } }))
      )
    ).toBe(true)
  })

  it('accepts distinct ids and rejects any id appearing twice', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(kebabCaseId, { minLength: 1, maxLength: 6 }),
        fc.nat(),
        (ids, pick) => {
          const apps = ids.map((id) => ({ ...app, id }))
          expect(Either.isRight(decodeDocument(documentOf(...apps)))).toBe(true)
          const duplicate = { ...app, id: ids[pick % ids.length], name: 'Another' }
          expect(Either.isLeft(decodeDocument(documentOf(...apps, duplicate)))).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

describe('LaunchUrl', () => {
  it('accepts any https: URL that carries neither iss nor launch', () => {
    fc.assert(
      fc.property(httpsUrl, (text) => {
        expect(decodeLaunchUrl(text)).toEqual(Either.right(text))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects any URL that is not https:', () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ['http', 'ftp'] }), (text) => {
        expect(Either.isLeft(decodeLaunchUrl(text))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects a URL carrying iss or launch, which the launcher adds', () => {
    fc.assert(
      fc.property(httpsUrl, fc.constantFrom('iss', 'launch'), (text, name) => {
        const url = new URL(text)
        url.searchParams.append(name, 'x')
        expect(Either.isLeft(decodeLaunchUrl(url.href))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects a URL carrying credentials', () => {
    expect(Either.isLeft(decodeLaunchUrl('https://user@example.com/launch'))).toBe(true)
    expect(Either.isLeft(decodeLaunchUrl('https://user:secret@example.com/launch'))).toBe(true)
  })

  it('rejects text that is not a URL', () => {
    expect(Either.isLeft(decodeLaunchUrl('launch.html'))).toBe(true)
  })
})

describe('SmartScope', () => {
  it('accepts FHIR v1 and v2 scopes, wildcards and known scopes', () => {
    for (const scope of [
      'launch',
      'openid',
      'fhirUser',
      'profile',
      'offline_access',
      'patient/*.read',
      'patient/Observation.read',
      'system/Patient.rs',
      'system/Observation.crus',
      'system/DocumentReference.cruds',
      'system/Patient.cu',
    ]) {
      expect(decodeScope(scope)).toEqual(Either.right(scope))
    }
  })

  it('rejects a scope Scope.parse reads as unknown', () => {
    for (const scope of ['', 'read', 'patient/Observation', 'system/Patient.xyz', 'a b']) {
      expect(Either.isLeft(decodeScope(scope))).toBe(true)
    }
  })
})

describe('SUGGESTED_APPS_URL', () => {
  it('is the file at the root of the site', () => {
    expect(SUGGESTED_APPS_URL).toBe('https://wildflowerhealth.io/suggested_apps.json')
  })
})
