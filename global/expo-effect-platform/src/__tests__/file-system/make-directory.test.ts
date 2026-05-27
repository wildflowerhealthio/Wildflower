jest.mock('../../ExpoEffectPlatformModule', () => ({ __esModule: true, default: {} }))
jest.mock('expo-file-system', () => jest.requireActual('./mock-expo-file-system'))

import * as FileSystem from '@effect/platform/FileSystem'
import * as Effect from 'effect/Effect'
import { resetMockFs, stage } from './mock-expo-file-system.ts'
import { ExpoFileSystem, expectFailureCause, runFs } from './run-fs.ts'

beforeEach(() => {
  resetMockFs()
})

describe('ExpoFileSystem / makeDirectory', () => {
  test('creates a directory and is idempotent under recursive', async () => {
    await runFs((fs) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory('/cache/new', { recursive: true })
        expect(yield* fs.exists('/cache/new')).toBe(true)
        // Second call must not throw — `recursive: true` maps to both
        // `intermediates` and `idempotent` on expo-file-system.
        yield* fs.makeDirectory('/cache/new', { recursive: true })
        expect(yield* fs.exists('/cache/new')).toBe(true)
      })
    )
  })

  test('non-recursive create on an existing directory fails with AlreadyExists', async () => {
    stage('/cache/exists', { kind: 'dir', size: 0 })
    const error = await expectFailureCause(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory('/cache/exists')).pipe(
        Effect.provide(ExpoFileSystem.layer)
      )
    )
    expect(error).toMatchObject({
      _tag: 'SystemError',
      reason: 'AlreadyExists',
      pathOrDescriptor: '/cache/exists',
    })
  })

  test('non-recursive create on an existing file path fails with AlreadyExists', async () => {
    stage('/cache/file.txt', {
      kind: 'file',
      bytes: new Uint8Array(),
      modificationTime: null,
    })
    const error = await expectFailureCause(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory('/cache/file.txt')).pipe(
        Effect.provide(ExpoFileSystem.layer)
      )
    )
    expect(error).toMatchObject({
      _tag: 'SystemError',
      reason: 'AlreadyExists',
      pathOrDescriptor: '/cache/file.txt',
    })
  })
})
