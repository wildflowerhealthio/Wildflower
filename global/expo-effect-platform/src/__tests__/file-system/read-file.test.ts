jest.mock('../../ExpoEffectPlatformModule', () => ({ __esModule: true, default: {} }))
jest.mock('expo-file-system', () => jest.requireActual('./mock-expo-file-system'))

import * as FileSystem from '@effect/platform/FileSystem'
import * as Effect from 'effect/Effect'
import { resetMockFs, stage } from './mock-expo-file-system.ts'
import { ExpoFileSystem, expectFailureCause, runFs } from './run-fs.ts'

beforeEach(() => {
  resetMockFs()
})

describe('ExpoFileSystem / readFile (+ derived readFileString)', () => {
  test('readFile returns the bytes for an existing file', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    stage('/cache/known.bin', { kind: 'file', bytes, modificationTime: null })
    await runFs((fs) =>
      Effect.gen(function* () {
        const read = yield* fs.readFile('/cache/known.bin')
        expect(read).toEqual(bytes)
      })
    )
  })

  test('readFileString returns the decoded string for an existing file', async () => {
    stage('/cache/known.txt', {
      kind: 'file',
      bytes: new TextEncoder().encode('hi there'),
      modificationTime: null,
    })
    await runFs((fs) =>
      Effect.gen(function* () {
        expect(yield* fs.readFileString('/cache/known.txt')).toBe('hi there')
      })
    )
  })

  test('readFile on missing path fails with NotFound', async () => {
    const error = await expectFailureCause(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFile('/cache/missing')).pipe(
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
