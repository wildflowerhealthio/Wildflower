import { Effect, Option } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import { removeStorageItem, setStorageItem, StorageBlocked, takeStorageItem } from './index.ts'

/** A store holding `items`, whose calls named in `refusing` throw as a blocked store's do. */
const storeOf = (
  items: Record<string, string>,
  refusing: ReadonlyArray<'getItem' | 'setItem' | 'removeItem'> = []
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => {
  const held = new Map(Object.entries(items))
  const refuseOr =
    <A extends unknown[], R>(name: (typeof refusing)[number], call: (...args: A) => R) =>
    (...args: A): R => {
      if (refusing.includes(name)) {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      }
      return call(...args)
    }
  return {
    getItem: vi.fn(refuseOr('getItem', (key: string) => held.get(key) ?? null)),
    setItem: vi.fn(
      refuseOr('setItem', (key: string, value: string) => {
        held.set(key, value)
      })
    ),
    removeItem: vi.fn(
      refuseOr('removeItem', (key: string) => {
        held.delete(key)
      })
    ),
  }
}

describe('takeStorageItem', () => {
  it('should read the item and remove it, so a second take finds none', async () => {
    const store = storeOf({ request: 'kept' })

    const first = await Effect.runPromise(takeStorageItem(store, 'request'))
    const second = await Effect.runPromise(takeStorageItem(store, 'request'))

    expect([first, second]).toEqual([Option.some('kept'), Option.none()])
  })

  it('should remove nothing when there is no item', async () => {
    const store = storeOf({})

    await Effect.runPromise(takeStorageItem(store, 'request'))

    expect(store.removeItem).not.toHaveBeenCalled()
  })

  it('should fail naming the read when the store refuses it', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(takeStorageItem(storeOf({ request: 'kept' }, ['getItem']), 'request'))
    )

    expect(failure).toEqual(new StorageBlocked({ operation: 'read', key: 'request' }))
  })

  it('should fail naming the removal when the store refuses it', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(takeStorageItem(storeOf({ request: 'kept' }, ['removeItem']), 'request'))
    )

    expect(failure).toEqual(new StorageBlocked({ operation: 'remove', key: 'request' }))
  })
})

describe('setStorageItem', () => {
  it('should write the item', async () => {
    const store = storeOf({})

    await Effect.runPromise(setStorageItem(store, 'request', 'kept'))

    expect(store.getItem('request')).toBe('kept')
  })

  it('should fail naming the write when the store refuses it', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(setStorageItem(storeOf({}, ['setItem']), 'request', 'kept'))
    )

    expect(failure).toEqual(new StorageBlocked({ operation: 'write', key: 'request' }))
  })
})

describe('removeStorageItem', () => {
  it('should remove the item', async () => {
    const store = storeOf({ request: 'kept' })

    await Effect.runPromise(removeStorageItem(store, 'request'))

    expect(store.getItem('request')).toBeNull()
  })

  it('should fail naming the removal when the store refuses it', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(removeStorageItem(storeOf({ request: 'kept' }, ['removeItem']), 'request'))
    )

    expect(failure).toEqual(new StorageBlocked({ operation: 'remove', key: 'request' }))
  })
})
