import { Either } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as ReturnTargetStore from './return-target-store.ts'
import * as ReturnTarget from './return-target.ts'

describe('fromWebStorage', () => {
  it("should recall the Pebble app's close URL when the page was opened without a return_to", () => {
    // Arrange
    const store = ReturnTargetStore.fromWebStorage(memoryStorage())

    // Act
    const target = store.recall()

    // Assert
    expect(target).toStrictEqual(Either.right(ReturnTarget.DEFAULT))
  })

  it('should recall the return target the page was opened with', () => {
    // Arrange
    const store = ReturnTargetStore.fromWebStorage(memoryStorage())
    store.rememberFrom(pageOpenedWith('http://localhost:61234/close?'))

    // Act
    const target = store.recall()

    // Assert
    expect(target).toStrictEqual(Either.right('http://localhost:61234/close?'))
  })

  it('should keep the remembered target when the OAuth callback lands without one', () => {
    // Arrange
    const store = ReturnTargetStore.fromWebStorage(memoryStorage())
    store.rememberFrom(pageOpenedWith('http://localhost:61234/close?'))

    // Act
    store.rememberFrom(new URL('https://wildflowerhealth.io/fhir-sync-pebble/?code=abc'))

    // Assert
    expect(store.recall()).toStrictEqual(Either.right('http://localhost:61234/close?'))
  })

  it('should keep the target across stores over the same storage, as across a page load', () => {
    // Arrange
    const storage = memoryStorage()
    ReturnTargetStore.fromWebStorage(storage).rememberFrom(pageOpenedWith('pebblejs://close#'))

    // Act
    const target = ReturnTargetStore.fromWebStorage(storage).recall()

    // Assert
    expect(target).toStrictEqual(Either.right('pebblejs://close#'))
  })

  it('should never recall a remembered target that is not the Pebble app or an emulator', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        // Arrange
        const store = ReturnTargetStore.fromWebStorage(memoryStorage())
        store.rememberFrom(pageOpenedWith(url))

        // Act
        const target = store.recall()

        // Assert
        expect(target).toStrictEqual(
          Either.left(new ReturnTarget.ForeignReturnTargetError({ returnTo: url }))
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** The page URL the Pebble phone app opens, carrying `returnTo`. */
const pageOpenedWith = (returnTo: string): URL => {
  const url = new URL('https://wildflowerhealth.io/fhir-sync-pebble/')
  url.searchParams.set(ReturnTarget.PARAM, returnTo)
  return url
}

/** A Web Storage stand-in backed by a `Map`. */
const memoryStorage = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
  }
}
