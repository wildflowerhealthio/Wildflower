import { describe, expect, it } from 'vite-plus/test'

import * as EnteredCredentials from './entered-credentials.ts'

describe('isClaimCode', () => {
  it.each([['ABCD-EFGH'], ['ABCDEFGH'], ['abcd-2345'], ['aBcD2345'], ['  WXYZ-6789  ']])(
    'should take %j as a claim code',
    (code) => {
      // Act
      const isCode = EnteredCredentials.isClaimCode(code)

      // Assert
      expect(isCode).toBe(true)
    }
  )

  it.each([
    ['', 'blank'],
    ['ABCD-EFG', 'one character short'],
    ['ABCDEFG', 'seven characters'],
    ['ABCD-EFGHJ', 'one character over'],
    ['ABCD-EFGO', 'an O'],
    ['ABCD-EFG0', 'a 0'],
    ['ABCD-EFG1', 'a 1'],
    ['ABCD-EFGI', 'an I'],
    ['ABCD-EFGL', 'an L'],
    ['ABC-DEFGH', 'the dash after three'],
    ['ABCDE-FGH', 'the dash after five'],
    ['ABCD--EFGH', 'two dashes'],
    ['ABCD EFGH', 'a space between the groups'],
    ['-ABCDEFGH', 'a leading dash'],
  ])('should not take %j, %s, as a claim code', (code) => {
    // Act
    const isCode = EnteredCredentials.isClaimCode(code)

    // Assert
    expect(isCode).toBe(false)
  })
})
