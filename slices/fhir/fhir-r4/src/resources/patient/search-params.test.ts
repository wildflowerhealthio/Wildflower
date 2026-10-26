import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { SearchParams } from './search-params.ts'

describe('PatientSearchParams', () => {
  it.each([
    { reason: 'a bare value', wire: '123' },
    { reason: 'the system|value form', wire: 'https://shoppers.example/customer|123' },
    {
      reason: 'several comma-joined tokens',
      wire: 'https://shoppers.example/customer|123,https://rexall.example/uid|abc',
    },
  ])('should carry an identifier given as $reason through the wire unchanged', ({ wire }) => {
    // Arrange
    const query = { identifier: wire }

    // Act
    const reEncoded = Schema.encodeSync(SearchParams)(Schema.decodeUnknownSync(SearchParams)(query))

    // Assert — an undeclared key would be dropped on decode and absent here.
    expect(reEncoded).toEqual(query)
  })
})
