import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { SearchParams } from './search-params.ts'

describe('MedicationDispenseSearchParams', () => {
  it('should carry every declared parameter through the wire unchanged', () => {
    // Arrange
    const query = {
      _count: '20',
      _pageToken: 'opaque-server-token',
      identifier: 'https://shoppers.example/fill|F-1,https://shoppers.example/fill|F-2',
    }

    // Act
    const reEncoded = Schema.encodeSync(SearchParams)(Schema.decodeUnknownSync(SearchParams)(query))

    // Assert — an undeclared key would be dropped on decode and absent here.
    expect(reEncoded).toEqual(query)
  })
})
