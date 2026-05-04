import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { Layer } from 'effect'
import type { LivestoreStore } from 'emr-core/contexts'
import { makeLivestoreStoreLayer } from 'emr-core/contexts'
import type { Patient as StorePatient } from 'emr-core/livestore'
import { Origin } from 'kitchen-sink'
import { describe, expect, test } from 'vite-plus/test'

import { FhirResourcesApiLive } from '../src/http-api-implementation/index.ts'
import { decodePageToken } from '../src/internal/page-token.ts'

type PatientRow = typeof StorePatient.RowSchema.Type

const patient = (
  id: string,
  gender: PatientRow['gender'] = null
): PatientRow & { readonly id: string } => ({
  resourceType: 'Patient',
  id,
  meta: { versionId: '', lastUpdated: null, source: '', security: [], tag: [] },
  implicitRules: new URL('http://a.aa/'),
  language: null,
  active: false,
  address: [],
  birthDate: null,
  communication: null,
  contact: null,
  deceasedBoolean: false,
  deceasedDateTime: null,
  gender,
  generalPractitioner: [],
  identifier: [],
  link: [],
  managingOrganization: null,
  maritalStatus: null,
  multipleBirthBoolean: false,
  multipleBirthInteger: null,
  name: [],
  photo: [],
  telecom: [],
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
})

// The mock store branches on the LiveQueryDef's `label` field — `search$` and
// `count$` are factory functions, so we cannot match by reference identity.
const makeStore = (rows: readonly PatientRow[], total: number): typeof LivestoreStore.Service =>
  /* oxlint-disable-next-line typescript/no-unsafe-type-assertion */
  ({
    query: (q: { readonly label?: string }): unknown => {
      const label = q.label ?? ''
      if (label.endsWith('.count')) {
        return total
      }
      if (label.endsWith('.getById')) {
        return rows[0]
      }
      return rows
    },
    commit: () => undefined,
  }) as unknown as typeof LivestoreStore.Service

const createHandler = (
  rows: readonly PatientRow[],
  total: number
): ReturnType<typeof HttpApiBuilder.toWebHandler> => {
  const apiLive = FhirResourcesApiLive.pipe(
    Layer.provide(makeLivestoreStoreLayer(makeStore(rows, total))),
    Layer.provide(Layer.succeed(Origin, 'http://localhost:8787'))
  )
  return HttpApiBuilder.toWebHandler(Layer.merge(apiLive, HttpServer.layerContext))
}

interface BundleEntry {
  readonly search: { readonly mode: string }
}
interface BundleLink {
  readonly relation: string
  readonly url: string
}
interface BundleResponse {
  readonly resourceType: string
  readonly type: string
  readonly total: number
  readonly entry: ReadonlyArray<BundleEntry>
  readonly link: ReadonlyArray<BundleLink>
}

const parseBundle = async (response: Response): Promise<BundleResponse> => {
  const json: unknown = await response.json()
  /* oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test inspects FHIR Bundle shape; runtime type narrowing would obscure the assertion */
  return json as BundleResponse
}

describe('Patient _search endpoint', () => {
  test('POST /_search with form body _count=25 returns searchset Bundle', async () => {
    const { handler, dispose } = createHandler([patient('p1'), patient('p2')], 2)
    try {
      const response = await handler(
        new Request('http://localhost:8787/fhir-r4/Patient/_search', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ _count: '25' }),
        })
      )

      expect(response.status).toBe(200)
      const body = await parseBundle(response)
      expect(body.resourceType).toBe('Bundle')
      expect(body.type).toBe('searchset')
      expect(body.total).toBe(2)
      expect(body.entry).toHaveLength(2)
      for (const entry of body.entry) {
        expect(entry.search.mode).toBe('match')
      }
      expect(body.link.some((l) => l.relation === 'self')).toBe(true)
    } finally {
      await dispose()
    }
  })

  test('GET / with query _count=25 returns searchset Bundle', async () => {
    const { handler, dispose } = createHandler([patient('p1', 'female')], 1)
    try {
      const response = await handler(
        new Request('http://localhost:8787/fhir-r4/Patient/?_count=25&gender=female')
      )
      expect(response.status).toBe(200)
      const body = await parseBundle(response)
      expect(body.type).toBe('searchset')
      expect(body.entry).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  test('paginated response emits next link with _pageToken; previous link absent on first page', async () => {
    // total=25, page size=10, offset=0 → next at offset=10, no previous
    const { handler, dispose } = createHandler(
      Array.from({ length: 10 }, (_, i) => patient(`p${i}`)),
      25
    )
    try {
      const response = await handler(
        new Request('http://localhost:8787/fhir-r4/Patient/_search', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ _count: '10' }),
        })
      )
      expect(response.status).toBe(200)
      const body = await parseBundle(response)
      const next = body.link.find((l) => l.relation === 'next')
      const prev = body.link.find((l) => l.relation === 'previous')
      expect(next).toBeDefined()
      expect(prev).toBeUndefined()
      const nextUrl = new URL(next?.url ?? '')
      const token = nextUrl.searchParams.get('_pageToken')
      expect(token).not.toBeNull()
      const decoded = decodePageToken(token ?? '')
      expect(decoded).toEqual({ offset: 10, count: 10 })
    } finally {
      await dispose()
    }
  })

  test('garbled _pageToken is treated as first page (lenient handling)', async () => {
    const { handler, dispose } = createHandler([patient('p1')], 1)
    try {
      const response = await handler(
        new Request('http://localhost:8787/fhir-r4/Patient/?_pageToken=not-base64')
      )
      expect(response.status).toBe(200)
      const body = await parseBundle(response)
      // No previous link (offset reset to 0); single match returned
      expect(body.entry).toHaveLength(1)
      expect(body.link.some((l) => l.relation === 'previous')).toBe(false)
    } finally {
      await dispose()
    }
  })

  test('POST /_search with application/json content-type is rejected', async () => {
    const { handler, dispose } = createHandler([], 0)
    try {
      const response = await handler(
        new Request('http://localhost:8787/fhir-r4/Patient/_search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ _count: 25 }),
        })
      )
      expect(response.status).toBe(400)
    } finally {
      await dispose()
    }
  })
})
