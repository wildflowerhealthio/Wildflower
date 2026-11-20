import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Equal, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { detached, OTHER_SOURCE, tyraWire } from '../import-plan.test-helpers.ts'
import * as RecordKey from './record-key.ts'

/** Covers what a record key is made of: a keyed record's key identifier, else its copy's review key. */

const binary = detached({ resourceType: 'Binary', contentType: 'text/plain' })

describe('RecordKey.make', () => {
  it('should key a record by its key identifier under its type', () => {
    // Arrange
    const tyra = detached(tyraWire('tyra'))

    // Act
    const key = RecordKey.make(tyra, 'a.har/tyra')

    // Assert
    expect(key).toEqual({
      _tag: 'Keyed',
      key: LogicalReference.key(
        LogicalReference.make('Patient', Option.getOrThrow(DetachedResource.keyIdentifierOf(tyra)))
      ),
    })
  })

  it('should key a record with no key identifier by its review key', () => {
    // Arrange / Act
    const key = RecordKey.make(binary, 'a.har/binary')

    // Assert
    expect(key).toEqual(RecordKey.Keyless({ reviewKey: 'a.har/binary' }))
  })
})

describe('RecordKey equality', () => {
  it('should hold two copies one record when their key identifiers agree, whatever their review keys and other fields', () => {
    // Arrange
    const fromHar = RecordKey.make(detached(tyraWire('tyra')), 'a.har/tyra')
    const fromPdf = RecordKey.make(detached(tyraWire('tyra', { gender: 'female' })), 'b.pdf/tyra')

    // Act / Assert
    expect(Equal.equals(fromHar, fromPdf)).toBe(true)
  })

  it('should hold two keyed records apart when their key identifiers differ in value or system', () => {
    // Arrange
    const tyra = RecordKey.make(detached(tyraWire('tyra')), 'a.har/tyra')
    const otherValue = RecordKey.make(detached(tyraWire('other')), 'a.har/tyra')
    const otherSystem = RecordKey.make(detached(tyraWire('tyra', {}, OTHER_SOURCE)), 'a.har/tyra')

    // Act / Assert
    expect([Equal.equals(tyra, otherValue), Equal.equals(tyra, otherSystem)]).toEqual([
      false,
      false,
    ])
  })

  it('should hold two keyless records one only under one review key', () => {
    // Arrange
    const first = RecordKey.make(binary, 'a.har/first')
    const sameKey = RecordKey.make(binary, 'a.har/first')
    const second = RecordKey.make(binary, 'a.har/second')

    // Act / Assert
    expect([Equal.equals(first, sameKey), Equal.equals(first, second)]).toEqual([true, false])
  })
})

describe('RecordKey.isKeyed', () => {
  it('should tell a keyed record’s key from a keyless one’s', () => {
    // Arrange / Act
    const keyed = [
      RecordKey.make(detached(tyraWire('tyra')), 'a.har/tyra'),
      RecordKey.make(binary, 'a.har/binary'),
    ].map(RecordKey.isKeyed)

    // Assert
    expect(keyed).toEqual([true, false])
  })
})

describe('RecordKey.logicalReferenceIfKeyed', () => {
  it('should give a keyed record’s key identifier under its type, and nothing for a keyless one', () => {
    // Arrange
    const tyra = detached(tyraWire('tyra'))

    // Act
    const logicalReferences = [tyra, binary].map(RecordKey.logicalReferenceIfKeyed)

    // Assert
    expect(logicalReferences).toEqual([
      Option.some(
        LogicalReference.make('Patient', Option.getOrThrow(DetachedResource.keyIdentifierOf(tyra)))
      ),
      Option.none(),
    ])
  })
})
