import { Effect, Option } from 'effect'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import * as BrowserStorage from './browser-storage.ts'

const AREAS = ['localStorage', 'sessionStorage'] as const

const originals = AREAS.map(
  (area) => [area, Object.getOwnPropertyDescriptor(globalThis, area)] as const
)

/** Give the page `area` as `get` reads it. */
const pageArea = (area: BrowserStorage.Area, get: () => unknown): void => {
  Object.defineProperty(globalThis, area, { configurable: true, get })
}

/** A `Map`-backed `Storage`. */
const memoryWebStorage = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

afterEach(() => {
  for (const [area, descriptor] of originals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, area)
    else Object.defineProperty(globalThis, area, descriptor)
  }
})

describe('BrowserStorage.layer', () => {
  it("should keep each store in the page's own area", () => {
    const local = memoryWebStorage()
    const session = memoryWebStorage()
    pageArea('localStorage', () => local)
    pageArea('sessionStorage', () => session)

    Effect.runSync(
      Effect.all([
        Effect.flatMap(BrowserStorage.Local, (store) => store.set('k', 'local')),
        Effect.flatMap(BrowserStorage.Session, (store) => store.set('k', 'session')),
      ]).pipe(Effect.provide(BrowserStorage.layer))
    )

    expect(local.getItem('k')).toBe('local')
    expect(session.getItem('k')).toBe('session')
  })

  it('should fail every call, never reading as nothing kept, when reading the area throws', () => {
    for (const area of AREAS) {
      pageArea(area, () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      })
    }

    const failures = Effect.runSync(
      Effect.all([
        Effect.flip(Effect.flatMap(BrowserStorage.Local, (store) => store.get('k'))),
        Effect.flip(Effect.flatMap(BrowserStorage.Session, (store) => store.set('k', 'v'))),
      ]).pipe(Effect.provide(BrowserStorage.layer))
    )

    expect(failures).toMatchObject([
      { _tag: 'SystemError', reason: 'PermissionDenied', method: 'get' },
      { _tag: 'SystemError', reason: 'PermissionDenied', method: 'set' },
    ])
  })

  it('should read nothing kept from an empty area', () => {
    pageArea('localStorage', memoryWebStorage)
    pageArea('sessionStorage', memoryWebStorage)

    expect(
      Effect.runSync(
        Effect.flatMap(BrowserStorage.Local, (store) => store.get('k')).pipe(
          Effect.provide(BrowserStorage.layer)
        )
      )
    ).toEqual(Option.none())
  })
})
