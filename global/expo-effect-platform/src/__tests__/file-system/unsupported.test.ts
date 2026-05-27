jest.mock('../../ExpoEffectPlatformModule', () => ({ __esModule: true, default: {} }))
jest.mock('expo-file-system', () => jest.requireActual('./mock-expo-file-system'))

import * as PlatformError from '@effect/platform/Error'
import * as FileSystem from '@effect/platform/FileSystem'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'
import { resetMockFs } from './mock-expo-file-system.ts'
import { ExpoFileSystem, expectFailureCause } from './run-fs.ts'

beforeEach(() => {
  resetMockFs()
})

describe('ExpoFileSystem / unsupported methods', () => {
  test.each([
    ['chmod', (fs: FileSystem.FileSystem) => fs.chmod('/cache/x', 0o644)],
    ['chown', (fs: FileSystem.FileSystem) => fs.chown('/cache/x', 0, 0)],
    ['copy', (fs: FileSystem.FileSystem) => fs.copy('/cache/x', '/cache/y')],
    ['copyFile', (fs: FileSystem.FileSystem) => fs.copyFile('/cache/x', '/cache/y')],
    ['link', (fs: FileSystem.FileSystem) => fs.link('/cache/x', '/cache/y')],
    ['makeTempDirectory', (fs: FileSystem.FileSystem) => fs.makeTempDirectory()],
    ['makeTempFile', (fs: FileSystem.FileSystem) => fs.makeTempFile()],
    ['open', (fs: FileSystem.FileSystem) => Effect.scoped(fs.open('/cache/x'))],
    ['readDirectory', (fs: FileSystem.FileSystem) => fs.readDirectory('/cache')],
    ['readLink', (fs: FileSystem.FileSystem) => fs.readLink('/cache/x')],
    ['realPath', (fs: FileSystem.FileSystem) => fs.realPath('/cache/x')],
    ['rename', (fs: FileSystem.FileSystem) => fs.rename('/cache/x', '/cache/y')],
    ['symlink', (fs: FileSystem.FileSystem) => fs.symlink('/cache/x', '/cache/y')],
    ['truncate', (fs: FileSystem.FileSystem) => fs.truncate('/cache/x')],
    ['utimes', (fs: FileSystem.FileSystem) => fs.utimes('/cache/x', new Date(), new Date())],
  ])('%s fails with reason BadResource', async (_label, call) => {
    const error = await expectFailureCause(
      Effect.flatMap(FileSystem.FileSystem, (fs) => call(fs)).pipe(
        Effect.provide(ExpoFileSystem.layer)
      )
    )
    expect(error).toBeInstanceOf(PlatformError.SystemError)
    expect(error).toMatchObject({ _tag: 'SystemError', reason: 'BadResource' })
  })

  test('watch fails with reason BadResource (routed via Stream.fail)', async () => {
    // `watch` returns a `Stream`, not an `Effect`, so it never hits the
    // `Effect.fail` path the rest of the unsupported methods use. Drain
    // the stream into an Effect to capture the typed failure.
    const error = await expectFailureCause(
      Effect.flatMap(FileSystem.FileSystem, (fs) => Stream.runDrain(fs.watch('/cache/x'))).pipe(
        Effect.provide(ExpoFileSystem.layer)
      )
    )
    expect(error).toBeInstanceOf(PlatformError.SystemError)
    expect(error).toMatchObject({ _tag: 'SystemError', reason: 'BadResource' })
  })
})
