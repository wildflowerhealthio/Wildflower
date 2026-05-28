jest.mock('../../ExpoEffectPlatformModule', () => ({ __esModule: true, default: {} }))
jest.mock('expo-file-system', () => jest.requireActual('./mock-expo-file-system'))

import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { resetMockFs } from './mock-expo-file-system.ts'
import { ExpoFileSystem, expectFailureCause, runFs } from './run-fs.ts'

beforeEach(() => {
  resetMockFs()
})

describe('ExpoFileSystem / writeFile (+ derived writeFileString)', () => {
  test('writeFileString → readFileString round-trip preserves the string', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (data) => {
        resetMockFs()
        await runFs((fs) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory('/cache/wf', { recursive: true })
            yield* fs.writeFileString('/cache/wf/index.html', data)
            expect(yield* fs.readFileString('/cache/wf/index.html')).toBe(data)
          })
        )
      }),
      { numRuns: 25 }
    )
  })

  test('writeFile → readFile round-trip over arbitrary Uint8Array', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array(), async (data) => {
        resetMockFs()
        await runFs((fs) =>
          Effect.gen(function* () {
            yield* fs.writeFile('/cache/bytes.bin', data)
            const read = yield* fs.readFile('/cache/bytes.bin')
            expect(read).toEqual(data)
          })
        )
      }),
      { numRuns: 25 }
    )
  })

  test('stat.size matches the written byteLength', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array(), async (data) => {
        resetMockFs()
        await runFs((fs) =>
          Effect.gen(function* () {
            yield* fs.writeFile('/cache/sized.bin', data)
            const info = yield* fs.stat('/cache/sized.bin')
            expect(Number(info.size)).toBe(data.byteLength)
          })
        )
      }),
      { numRuns: 25 }
    )
  })

  test('writeFileString overwrites an existing file', async () => {
    await runFs((fs) =>
      Effect.gen(function* () {
        yield* fs.writeFileString('/cache/idx.html', 'first')
        yield* fs.writeFileString('/cache/idx.html', 'second')
        expect(yield* fs.readFileString('/cache/idx.html')).toBe('second')
      })
    )
  })

  test('non-default flag is rejected with a typed SystemError', async () => {
    const error = await expectFailureCause(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFile('/cache/append.bin', new Uint8Array([1, 2, 3]), { flag: 'a' })
      ).pipe(Effect.provide(ExpoFileSystem.layer))
    )
    expect(error).toMatchObject({
      _tag: 'SystemError',
      reason: 'BadResource',
      pathOrDescriptor: '/cache/append.bin',
    })
  })
})
