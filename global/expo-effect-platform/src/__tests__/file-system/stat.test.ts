jest.mock('../../ExpoEffectPlatformModule', () => ({ __esModule: true, default: {} }))
jest.mock('expo-file-system', () => jest.requireActual('./mock-expo-file-system'))

import * as FileSystem from '@effect/platform/FileSystem'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { resetMockFs, stage } from './mock-expo-file-system.ts'
import { ExpoFileSystem, expectFailureCause, runFs } from './run-fs.ts'

beforeEach(() => {
  resetMockFs()
})

describe('ExpoFileSystem / stat', () => {
  test('stat on a file returns type: File with size and mtime', async () => {
    const bytes = new TextEncoder().encode('hello world')
    stage('/cache/known.txt', { kind: 'file', bytes, modificationTime: 0xabc })
    await runFs((fs) =>
      Effect.gen(function* () {
        const info = yield* fs.stat('/cache/known.txt')
        expect(info.type).toBe('File')
        expect(Number(info.size)).toBe(bytes.byteLength)
        expect(Option.getOrNull(info.mtime)).toEqual(new Date(0xabc))
      })
    )
  })

  test('stat on a directory returns type: Directory', async () => {
    stage('/cache/dir', { kind: 'dir', size: 42 })
    await runFs((fs) =>
      Effect.gen(function* () {
        const info = yield* fs.stat('/cache/dir')
        expect(info.type).toBe('Directory')
        expect(Number(info.size)).toBe(42)
      })
    )
  })

  test('stat on a directory whose size is null surfaces PermissionDenied', async () => {
    // expo-file-system's docs call out `Directory.size === null` as
    // "unreadable" (e.g. permission failure). It must not silently
    // coalesce to `size: 0` — exercising the explicit failure branch.
    stage('/cache/sealed', { kind: 'dir', size: null })
    const error = await expectFailureCause(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat('/cache/sealed')).pipe(
        Effect.provide(ExpoFileSystem.layer)
      )
    )
    expect(error).toMatchObject({
      _tag: 'SystemError',
      reason: 'PermissionDenied',
      pathOrDescriptor: '/cache/sealed',
    })
  })

  test('stat on missing path fails with NotFound', async () => {
    const error = await expectFailureCause(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat('/cache/missing')).pipe(
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
