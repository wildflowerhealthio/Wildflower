import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Equal, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { detached, OTHER_SOURCE, tyraWire } from '../import-plan.test-helpers.ts'
import * as RecordKey from './record-key.ts'

/**
 * Covers what a record key is made of: a record's key identifier, else the
 * URL a source served it at, else its copy's review key, which the importer
 * assigns.
 */

const binary = detached({ resourceType: 'Binary', contentType: 'text/plain' })
const binaryUrl = new URL('https://fhir.example/r4/Binary/report-1')

describe('RecordKey.make', () => {
  it('should key a record by its key identifier under its type', () => {
    // Arrange
    const tyra = detached(tyraWire('tyra'))

    // Act
    const key = RecordKey.make({
      resource: tyra,
      sourceUrl: Option.none(),
      reviewKey: 'a.har/tyra',
    })

    // Assert
    expect(key).toEqual({
      _tag: 'ByIdentifier',
      key: LogicalReference.key(
        LogicalReference.make('Patient', Option.getOrThrow(DetachedResource.keyIdentifierOf(tyra)))
      ),
    })
  })

  it('should key a record with no key identifier or source URL by its importer-assigned review key', () => {
    // Arrange / Act
    const key = RecordKey.make({
      resource: binary,
      sourceUrl: Option.none(),
      reviewKey: 'a.har/binary',
    })

    // Assert
    expect(key).toEqual(RecordKey.ByImporterAssignedKey({ reviewKey: 'a.har/binary' }))
  })

  it('should key a record with no key identifier that a source served at a URL by that URL', () => {
    // Arrange / Act
    const key = RecordKey.make({
      resource: binary,
      sourceUrl: Option.some(binaryUrl),
      reviewKey: 'a.har/binary',
    })

    // Assert
    expect(key).toEqual(RecordKey.BySourceUrl({ sourceUrl: binaryUrl.href }))
  })

  it('should key a record by its key identifier before its source URL', () => {
    // Arrange
    const tyra = detached(tyraWire('tyra'))

    // Act
    const [withSourceUrl, withoutSourceUrl] = [Option.some(binaryUrl), Option.none()].map(
      (sourceUrl) => RecordKey.make({ resource: tyra, sourceUrl, reviewKey: 'a.har/tyra' })
    )

    // Assert
    expect(withSourceUrl).toEqual(withoutSourceUrl)
  })
})

describe('RecordKey equality', () => {
  it('should hold two copies one record when their key identifiers agree, whatever their review keys and other fields', () => {
    // Arrange
    const fromHar = RecordKey.make({
      resource: detached(tyraWire('tyra')),
      sourceUrl: Option.none(),
      reviewKey: 'a.har/tyra',
    })
    const fromPdf = RecordKey.make({
      resource: detached(tyraWire('tyra', { gender: 'female' })),
      sourceUrl: Option.none(),
      reviewKey: 'b.pdf/tyra',
    })

    // Act / Assert
    expect(Equal.equals(fromHar, fromPdf)).toBe(true)
  })

  it('should hold two keyed records apart when their key identifiers differ in value or system', () => {
    // Arrange
    const tyra = RecordKey.make({
      resource: detached(tyraWire('tyra')),
      sourceUrl: Option.none(),
      reviewKey: 'a.har/tyra',
    })
    const otherValue = RecordKey.make({
      resource: detached(tyraWire('other')),
      sourceUrl: Option.none(),
      reviewKey: 'a.har/tyra',
    })
    const otherSystem = RecordKey.make({
      resource: detached(tyraWire('tyra', {}, OTHER_SOURCE)),
      sourceUrl: Option.none(),
      reviewKey: 'a.har/tyra',
    })

    // Act / Assert
    expect([Equal.equals(tyra, otherValue), Equal.equals(tyra, otherSystem)]).toEqual([
      false,
      false,
    ])
  })

  it('should hold two records keyed by the importer one only under one review key', () => {
    // Arrange
    const first = RecordKey.make({
      resource: binary,
      sourceUrl: Option.none(),
      reviewKey: 'a.har/first',
    })
    const sameKey = RecordKey.make({
      resource: binary,
      sourceUrl: Option.none(),
      reviewKey: 'a.har/first',
    })
    const second = RecordKey.make({
      resource: binary,
      sourceUrl: Option.none(),
      reviewKey: 'a.har/second',
    })

    // Act / Assert
    expect([Equal.equals(first, sameKey), Equal.equals(first, second)]).toEqual([true, false])
  })
})

describe('RecordKey equality by source URL', () => {
  it('should hold two copies one record when a source served both at one URL, whatever their review keys', () => {
    // Arrange
    const fromFirstCapture = RecordKey.make({
      resource: binary,
      sourceUrl: Option.some(binaryUrl),
      reviewKey: 'a.har/binary',
    })
    const fromSecondCapture = RecordKey.make({
      resource: detached({ resourceType: 'Binary', contentType: 'application/pdf' }),
      sourceUrl: Option.some(new URL(binaryUrl.href)),
      reviewKey: 'b.har/binary',
    })

    // Act / Assert
    expect(Equal.equals(fromFirstCapture, fromSecondCapture)).toBe(true)
  })

  it('should hold two copies apart when a source served them at different URLs', () => {
    // Arrange
    const first = RecordKey.make({
      resource: binary,
      sourceUrl: Option.some(binaryUrl),
      reviewKey: 'a.har/binary',
    })
    const other = RecordKey.make({
      resource: binary,
      sourceUrl: Option.some(new URL('https://fhir.example/r4/Binary/report-2')),
      reviewKey: 'a.har/binary',
    })

    // Act / Assert
    expect(Equal.equals(first, other)).toBe(false)
  })
})

describe('RecordKey.isKeyed', () => {
  it('should tell a key identifier’s key from a source URL’s and a review key’s', () => {
    // Arrange / Act
    const keyed = [
      RecordKey.make({
        resource: detached(tyraWire('tyra')),
        sourceUrl: Option.none(),
        reviewKey: 'a.har/tyra',
      }),
      RecordKey.make({ resource: binary, sourceUrl: Option.some(binaryUrl), reviewKey: 'a.har/b' }),
      RecordKey.make({ resource: binary, sourceUrl: Option.none(), reviewKey: 'a.har/binary' }),
    ].map(RecordKey.isKeyed)

    // Assert
    expect(keyed).toEqual([true, false, false])
  })
})
