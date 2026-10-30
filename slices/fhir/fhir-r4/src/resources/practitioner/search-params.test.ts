import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { SearchParams } from './search-params.ts'

describe('PractitionerSearchParams', () => {
  it.each([
    { reason: 'a bare value', wire: 'A1234' },
    { reason: 'the system|value form', wire: 'https://cpso.example/licence|A1234' },
    {
      reason: 'several comma-joined tokens',
      wire: 'https://cpso.example/licence|A1234,https://lifelabs.example/provider|77',
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
