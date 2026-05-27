jest.mock('../../ExpoEffectPlatformModule', () => ({ __esModule: true, default: {} }))
jest.mock('expo-file-system', () => jest.requireActual('./mock-expo-file-system'))

import * as FileSystem from '@effect/platform/FileSystem'
import * as Effect from 'effect/Effect'
import { resetMockFs, stage } from './mock-expo-file-system.ts'
import { ExpoFileSystem, expectFailureCause, runFs } from './run-fs.ts'

beforeEach(() => {
  resetMockFs()
})

describe('ExpoFileSystem / remove', () => {
  test('remove deletes an existing file', async () => {
    stage('/cache/old.txt', {
      kind: 'file',
      bytes: new TextEncoder().encode('x'),
      modificationTime: null,
    })
    await runFs((fs) =>
      Effect.gen(function* () {
        yield* fs.remove('/cache/old.txt')
        expect(yield* fs.exists('/cache/old.txt')).toBe(false)
      })
    )
  })

  test('remove deletes an existing directory', async () => {
    stage('/cache/old', { kind: 'dir', size: 0 })
    await runFs((fs) =>
      Effect.gen(function* () {
        yield* fs.remove('/cache/old', { recursive: true })
        expect(yield* fs.exists('/cache/old')).toBe(false)
      })
    )
  })

  test('remove on missing path with force is a no-op', async () => {
    await runFs((fs) =>
      Effect.gen(function* () {
        yield* fs.remove('/cache/never-existed', { force: true })
      })
    )
  })

  test('remove on missing path without force fails with NotFound', async () => {
    const error = await expectFailureCause(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove('/cache/missing')).pipe(
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
