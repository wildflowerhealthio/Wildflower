jest.mock('../../ExpoEffectPlatformModule', () => ({ __esModule: true, default: {} }))
jest.mock('expo-file-system', () => jest.requireActual('./mock-expo-file-system'))

import * as FileSystem from '@effect/platform/FileSystem'
import * as Server from '@effect/platform/HttpServer'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { resetMockFs } from './mock-expo-file-system.ts'
import { ExpoFileSystem, expectFailureCause } from './run-fs.ts'

beforeEach(() => {
  resetMockFs()
})

describe('ExpoFileSystem / composition with HttpServer.layerContext', () => {
  test('ExpoFileSystem.layer listed AFTER Server.layerContext wins (Expo impl takes effect)', async () => {
    // This pins the `Context.mergeAll` last-writer-wins ordering that
    // `ExpoContext.layer` depends on. If the noop from `Server.layerContext`
    // were winning, `writeFileString` would fail (noop's `writeFile` rejects).
    const composed = Layer.mergeAll(Server.layerContext, ExpoFileSystem.layer)
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString('/cache/ord.html', '<p>hi</p>')
      return yield* fs.readFileString('/cache/ord.html')
    }).pipe(Effect.provide(composed))
    const result = await Effect.runPromise(program)
    expect(result).toBe('<p>hi</p>')
  })

  test('with the order reversed, the noop wins (regression guard on ordering)', async () => {
    const composed = Layer.mergeAll(ExpoFileSystem.layer, Server.layerContext)
    const error = await expectFailureCause(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.writeFileString('/cache/noop.html', 'x')
      ).pipe(Effect.provide(composed))
    )
    // The noop's `writeFileString` rejects with `SystemError NotFound`.
    expect(error).toMatchObject({ _tag: 'SystemError', reason: 'NotFound' })
  })
})
