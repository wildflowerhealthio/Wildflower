import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as LinkableLogicalReference from './linkable-logical-reference.ts'

/** Covers the narrowing of a logical reference to the types the identity map links. */

const decodeReference = Schema.decodeUnknownSync(IdentifierAndReference.ReferenceSchema)

const SYSTEM = 'https://source.example/id'

describe('LinkableLogicalReference.tryFromReference', () => {
  it.each(['Patient', 'Practitioner'])('reads a logical reference to a %s', (type) => {
    expect(
      Option.map(
        LinkableLogicalReference.tryFromReference(
          decodeReference({ type, identifier: { system: SYSTEM, value: 'x-1' } })
        ),
        ({ resourceType, identifier: [{ system, value }] }) => [resourceType, system.href, value]
      )
    ).toEqual(Option.some([type, SYSTEM, 'x-1']))
  })

  it.each([
    {
      name: 'a logical reference to a type the map does not link',
      wire: { type: 'Organization', identifier: { system: SYSTEM, value: 'org-1' } },
    },
    {
      name: 'an untyped identifier',
      wire: { identifier: { system: SYSTEM, value: 'x-1' } },
    },
    {
      name: 'a literal',
      wire: {
        reference: 'Patient/1',
        type: 'Patient',
        identifier: { system: SYSTEM, value: 'x-1' },
      },
    },
  ])('reads nothing off $name', ({ wire }) => {
    expect(LinkableLogicalReference.tryFromReference(decodeReference(wire))).toEqual(Option.none())
  })
})
