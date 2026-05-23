import { Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { Address as StoreAddress } from 'emr-core/schemas'
import { Extension as StoreExtension } from 'emr-core/schemas'

import * as Address from '../complex/address.ts'
// Importing Extension also imports the rest of the datatype barrel through
// element.ts → extension.ts → choice-element-passthrough-fields.ts; the
// complex datatype modules import-order in `../index.ts` guarantees Address
// (and friends) are registered before any `value[x]` decode/encode runs.
import * as Extension from '../special-purpose/extension.ts'
import { baseDatatypes, resolveDatatypeSchema } from './datatype-registry.ts'

describe('fhir-r4 datatype registry', () => {
  test('Address self-registers a fhir-r4 wire-format schema', () => {
    expect(baseDatatypes.Address).toBeDefined()
    expect(resolveDatatypeSchema('Address')).toBe(Address.Schema)
  })

  test('value[x] choice resolves valueAddress through the fhir-r4 wire schema', () => {
    const storeAddress: typeof StoreAddress.Schema.Type = {
      id: null,
      extension: [],
      use: 'home',
      type: null,
      text: null,
      line: ['1 Main St'],
      city: 'Springfield',
      district: null,
      state: 'IL',
      postalCode: null,
      country: null,
      period: null,
    }

    const storeExtension: typeof StoreExtension.Schema.Type = {
      ...StoreExtension.emptyValueChoice,
      id: null,
      extension: [],
      url: 'http://example.org/ext/home-address',
      valueAddress: storeAddress,
    }

    const encoded = Schema.encodeSync(Extension.Schema)(storeExtension)

    // fhir-r4 wire format: null in memory → undefined on the wire (via
    // `OrNullAsOptional`). That's the distinguishing behavior vs. emr-core's
    // store-format `Schema.NullOr` that the bug was leaking through — store
    // would emit literal `null` for these.
    expect(encoded.valueAddress).toBeDefined()
    expect(encoded.valueAddress?.use).toBe('home')
    expect(encoded.valueAddress?.city).toBe('Springfield')
    expect(encoded.valueAddress?.type).toBeUndefined()
    expect(encoded.valueAddress?.text).toBeUndefined()
    expect(encoded.valueAddress?.country).toBeUndefined()

    const decoded = Schema.decodeSync(Extension.Schema)(encoded)
    expect(decoded.valueAddress).toEqual(storeAddress)
  })
})
