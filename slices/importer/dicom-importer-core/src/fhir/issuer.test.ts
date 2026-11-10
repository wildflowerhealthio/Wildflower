import type { HierarchicDesignator } from '@wildflowerhealthio/dicom'
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { issuedIdentifierOf, unresolvedUniversalIssuerOf, universalSystemOf } from './issuer.ts'

const FALLBACK = 'https://wildflowerhealth.io/fhir/sid/dicom/accession-number'

describe('universalSystemOf', () => {
  it('spells an ISO OID as urn:oid', () => {
    expect(universalSystemOf('1.2.840.113619', 'ISO')).toEqual(
      Option.some('urn:oid:1.2.840.113619')
    )
  })

  it('spells a UUID as urn:uuid, lower case', () => {
    expect(universalSystemOf('A1B2C3D4-0000-4000-8000-00000000000F', 'UUID')).toEqual(
      Option.some('urn:uuid:a1b2c3d4-0000-4000-8000-00000000000f')
    )
  })

  it('spells a URI as URL.href does, so two spellings of one URI name one system', () => {
    expect(universalSystemOf('https://pacs.example.org/ids', 'URI')).toEqual(
      Option.some('https://pacs.example.org/ids')
    )
    expect(universalSystemOf('HTTPS://pacs.example.org', 'URI')).toEqual(
      Option.some('https://pacs.example.org/')
    )
  })

  it('names no system for another type, or a value malformed for its type', () => {
    expect(universalSystemOf('pacs.example.org', 'DNS')).toEqual(Option.none())
    expect(universalSystemOf('1.02.3', 'ISO')).toEqual(Option.none())
    expect(universalSystemOf('HOSPITAL', 'ISO')).toEqual(Option.none())
    expect(universalSystemOf('not-a-uuid', 'UUID')).toEqual(Option.none())
    expect(universalSystemOf('not a uri', 'URI')).toEqual(Option.none())
  })
})

describe('unresolvedUniversalIssuerOf', () => {
  it('names a stated universal id that resolves to no URI, and nothing else', () => {
    const issuer = (
      universalEntityId?: string,
      universalEntityIdType?: string
    ): HierarchicDesignator.Type => ({
      localNamespaceEntityId: 'LOCAL',
      universalEntityId,
      universalEntityIdType,
    })
    expect(unresolvedUniversalIssuerOf(issuer('pacs.example.org', 'DNS'))).toEqual(
      Option.some('pacs.example.org (DNS), which names no URI')
    )
    expect(unresolvedUniversalIssuerOf(issuer('1.2.3'))).toEqual(
      Option.some('1.2.3 with no Universal Entity ID Type (0040,0033)')
    )
    expect(unresolvedUniversalIssuerOf(issuer('1.2.3', 'ISO'))).toEqual(Option.none())
    expect(unresolvedUniversalIssuerOf(issuer())).toEqual(Option.none())
    expect(unresolvedUniversalIssuerOf(undefined)).toEqual(Option.none())
  })
})

describe('issuedIdentifierOf', () => {
  it('keys under the fallback with no issuer at all', () => {
    expect(issuedIdentifierOf('A1', undefined, FALLBACK)).toEqual({
      key: { system: FALLBACK, value: 'A1' },
      assignerDisplay: Option.none(),
      unresolvedIssuer: Option.none(),
    })
  })

  it('keys under the fallback and displays a universal id it cannot resolve', () => {
    expect(
      issuedIdentifierOf(
        'A1',
        {
          localNamespaceEntityId: undefined,
          universalEntityId: 'pacs.example.org',
          universalEntityIdType: 'DNS',
        },
        FALLBACK
      )
    ).toEqual({
      key: { system: FALLBACK, value: 'A1' },
      assignerDisplay: Option.some('pacs.example.org'),
      unresolvedIssuer: Option.some('pacs.example.org (DNS), which names no URI'),
    })
  })

  it('property: every issuer yields a key whose identifier decodes as a FHIR Identifier', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        fc.option(fc.constantFrom('ISO', 'UUID', 'URI', 'DNS', 'X500', 'iso'), { nil: undefined }),
        (value, localNamespaceEntityId, universalEntityId, universalEntityIdType) => {
          const { key } = issuedIdentifierOf(
            value,
            { localNamespaceEntityId, universalEntityId, universalEntityIdType },
            FALLBACK
          )
          expect(key.value).toBe(value)
          expect(() => new URL(key.system)).not.toThrow()
          expect(DetachedResource.keyIdentifierWire(key).system).toBe(key.system)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
