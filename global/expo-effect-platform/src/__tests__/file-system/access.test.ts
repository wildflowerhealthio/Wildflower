jest.mock('../../ExpoEffectPlatformModule', () => ({ __esModule: true, default: {} }))
jest.mock('expo-file-system', () => jest.requireActual('./mock-expo-file-system'))

import * as FileSystem from '@effect/platform/FileSystem'
import * as Effect from 'effect/Effect'
import { resetMockFs, stage } from './mock-expo-file-system.ts'
import { ExpoFileSystem, expectFailureCause, runFs } from './run-fs.ts'

beforeEach(() => {
  resetMockFs()
})

describe('ExpoFileSystem / access (and derived exists)', () => {
  test('exists returns true for an existing file', async () => {
    stage('/cache/x.txt', {
      kind: 'file',
      bytes: new TextEncoder().encode('hi'),
      modificationTime: null,
    })
    await runFs((fs) =>
      Effect.gen(function* () {
        expect(yield* fs.exists('/cache/x.txt')).toBe(true)
      })
    )
  })

  test('exists returns true for an existing directory', async () => {
    stage('/cache/dir', { kind: 'dir', size: 0 })
    await runFs((fs) =>
      Effect.gen(function* () {
        expect(yield* fs.exists('/cache/dir')).toBe(true)
      })
    )
  })

  test('exists returns false for a missing path', async () => {
    await runFs((fs) =>
      Effect.gen(function* () {
        expect(yield* fs.exists('/cache/missing')).toBe(false)
      })
    )
  })

  test('access fails with NotFound when path is missing', async () => {
    const error = await expectFailureCause(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.access('/cache/missing')).pipe(
        Effect.provide(ExpoFileSystem.layer)
      )
    )
    expect(error).toMatchObject({
      _tag: 'SystemError',
      reason: 'NotFound',
      pathOrDescriptor: '/cache/missing',
    })
  })
})
