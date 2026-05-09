/* oxlint-disable typescript-eslint/no-explicit-any, typescript-eslint/no-unsafe-type-assertion, typescript-eslint/no-unsafe-assignment */
import * as Etag from '@effect/platform/Etag'
import * as FileSystem from '@effect/platform/FileSystem'
import * as Headers from '@effect/platform/Headers'
import * as HttpPlatform from '@effect/platform/HttpPlatform'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

jest.mock('../ExpoEffectPlatformModule', () => ({
  __esModule: true,
  default: {},
}))

import type * as HttpPlatformModule from '../internal/httpPlatform.ts'

// `require` (not `import`) matches sibling test files where mock factories
// capture module-local variables that ES imports would race against.
const { make } = require('../internal/httpPlatform') as typeof HttpPlatformModule

function makeMockFsLayer(size: number = 1024): Layer.Layer<FileSystem.FileSystem> {
  return Layer.succeed(FileSystem.FileSystem, {
    stat: () =>
      Effect.succeed({
        type: 'File' as const,
        size: FileSystem.Size(size),
        mtime: Option.some(new Date('2024-01-01T00:00:00Z')),
        atime: Option.none(),
        birthtime: Option.none(),
        dev: 0,
        ino: Option.none(),
        mode: 0o644,
        nlink: Option.none(),
        uid: Option.none(),
        gid: Option.none(),
        rdev: Option.none(),
        blksize: Option.none(),
        blocks: Option.none(),
      }),
  } as any)
}

// ---------------------------------------------------------------------------
// Tests: ExpoHttpPlatform
// ---------------------------------------------------------------------------

describe('ExpoHttpPlatform', () => {
  test('fileResponse creates Raw body with ExpoFileBody sentinel', async () => {
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse('/data/scan.dcm', {
        status: 200,
        headers: Headers.fromInput({ 'content-type': 'application/dicom' }),
      })
      expect(response.status).toBe(200)
      const body = response.body as any
      expect(body._tag).toBe('Raw')
      expect(body.body.__expoFilePath).toBe('/data/scan.dcm')
      expect(body.body.start).toBe(0)
      expect(body.body.end).toBeUndefined()
    }).pipe(
      Effect.provide(Layer.effect(HttpPlatform.HttpPlatform, make)),
      Effect.provide(makeMockFsLayer(2048)),
      Effect.provide(Etag.layerWeak)
    )

    await Effect.runPromise(program)
  })

  test('fileResponse uses provided content-type', async () => {
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse('/data/image.png', {
        headers: Headers.fromInput({ 'content-type': 'image/png' }),
      })
      const body = response.body as any
      expect(body.contentType).toBe('image/png')
    }).pipe(
      Effect.provide(Layer.effect(HttpPlatform.HttpPlatform, make)),
      Effect.provide(makeMockFsLayer()),
      Effect.provide(Etag.layerWeak)
    )

    await Effect.runPromise(program)
  })

  test('fileResponse defaults to application/octet-stream when no content-type', async () => {
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse('/data/file.bin')
      const body = response.body as any
      expect(body.contentType).toBe('application/octet-stream')
    }).pipe(
      Effect.provide(Layer.effect(HttpPlatform.HttpPlatform, make)),
      Effect.provide(makeMockFsLayer()),
      Effect.provide(Etag.layerWeak)
    )

    await Effect.runPromise(program)
  })

  test('fileResponse preserves byte range (offset + bytesToRead)', async () => {
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse('/data/large.dcm', {
        status: 206,
        offset: 1024,
        bytesToRead: 512,
      })
      expect(response.status).toBe(206)
      const body = response.body as any
      expect(body.body.start).toBe(1024)
      expect(body.body.end).toBe(1536) // start + bytesToRead
    }).pipe(
      Effect.provide(Layer.effect(HttpPlatform.HttpPlatform, make)),
      Effect.provide(makeMockFsLayer(4096)),
      Effect.provide(Etag.layerWeak)
    )

    await Effect.runPromise(program)
  })

  test('fileWebResponse returns 501 Not Implemented', async () => {
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const file = {
        name: 'test.bin',
        size: 100,
        type: 'application/octet-stream',
        lastModified: Date.now(),
        stream: () => null,
      }
      const response = yield* platform.fileWebResponse(file as any)
      expect(response.status).toBe(501)
      const body = response.body as any
      expect(body._tag).toBe('Raw')
      expect(String(body.body)).toContain('not supported')
    }).pipe(
      Effect.provide(Layer.effect(HttpPlatform.HttpPlatform, make)),
      Effect.provide(makeMockFsLayer()),
      Effect.provide(Etag.layerWeak)
    )

    await Effect.runPromise(program)
  })
})
