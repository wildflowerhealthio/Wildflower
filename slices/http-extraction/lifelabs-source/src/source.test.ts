import { Effect } from 'effect'
import { localResourceId } from 'fhir-r4/identity'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { describe, expect, it } from 'vite-plus/test'

import summary from './fixtures/analytic-summary.json' with { type: 'json' }
import { LIFELABS_SYSTEM } from './source-system.ts'
import { lifeLabsSource } from './source.ts'

const SUMMARY_URL = 'https://on-api.mycarecompass.lifelabs.com/api/Report/GetAnalyticSummary'

describe('lifeLabsSource', () => {
  it('names the source and carries the one adopted kind', () => {
    expect(lifeLabsSource.name).toBe('lifelabs')
    expect(lifeLabsSource.responseKinds.map((k) => k.name)).toEqual([
      'AnalyticSummaryResponseKind',
      'ViewAnalyticsResponseKind',
    ])
  })

  it('re-keys the parsed resources under the LifeLabs system and rewrites the subject', () => {
    const [kind] = lifeLabsSource.responseKinds
    if (kind === undefined) throw new Error('expected a response kind')

    const resources = Effect.runSync(
      kind.parse(makeHttpResponse({ url: SUMMARY_URL, body: JSON.stringify(summary) }))
    )

    const patientId = localResourceId(LIFELABS_SYSTEM, 'Patient', '31653025')
    const [patient] = resources.filter((r) => r.resourceType === 'Patient')
    expect(patient?.id).toBe(patientId)
    for (const o of resources) {
      if (o.resourceType !== 'Observation') continue
      expect(o.subject?.reference).toBe(`Patient/${patientId}`)
    }
  })
})
