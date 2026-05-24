import * as Headers from '@effect/platform/Headers'
import * as HttpPlatform from '@effect/platform/HttpPlatform'
/* oxlint-disable typescript-eslint/no-explicit-any, typescript-eslint/no-unsafe-type-assertion, typescript-eslint/no-unsafe-assignment */
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'

jest.mock('../ExpoEffectPlatformModule', () => ({
  __esModule: true,
  default: {},
}))

// Module-level mock state captured by the `expo-file-system` factory below.
// `jest.mock` is hoisted above all imports, so the factory cannot close over
// `let` bindings declared here — instead we capture per-test state inside a
// `MOCK_FS` map keyed by URI and reset it from `beforeEach`.
type MockEntry = { exists: boolean; size: number; modificationTime: number | null }
const MOCK_FS = new Map<string, MockEntry>()

jest.mock('expo-file-system', () => {
  class MockFile {
    private readonly uri: string
    constructor(...uris: unknown[]) {
      // Mirrors the real constructor: first arg is the URI (or a parent).
      this.uri = String(uris[0])
    }
    get exists(): boolean {
      return MOCK_FS.get(this.uri)?.exists ?? false
    }
    get size(): number {
      return MOCK_FS.get(this.uri)?.size ?? 0
    }
    get modificationTime(): number | null {
      return MOCK_FS.get(this.uri)?.modificationTime ?? null
    }
  }
  return { __esModule: true, File: MockFile }
})

import type * as HttpPlatformModule from '../internal/httpPlatform.ts'

// `require` (not `import`) matches sibling test files where mock factories
// capture module-local variables that ES imports would race against.
const { make } = require('../internal/httpPlatform') as typeof HttpPlatformModule

const platformLayer = Layer.succeed(HttpPlatform.HttpPlatform, make)

const stageFile = (
  path: string,
  entry: { size: number; modificationTime?: number | null }
): void => {
  const uri = path.startsWith('file://') ? path : `file://${path}`
  MOCK_FS.set(uri, {
    exists: true,
    size: entry.size,
    modificationTime: entry.modificationTime ?? null,
  })
}

beforeEach(() => {
  MOCK_FS.clear()
})

// ---------------------------------------------------------------------------
// Tests: ExpoHttpPlatform
// ---------------------------------------------------------------------------

describe('ExpoHttpPlatform', () => {
  test('fileResponse creates Raw body with ExpoFileBody sentinel', async () => {
    stageFile('/data/scan.dcm', { size: 2048, modificationTime: 1_700_000_000_000 })
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse('/data/scan.dcm', {
        status: 200,
        headers: Headers.fromInput({ 'content-type': 'application/dicom' }),
      })
      expect(response.status).toBe(200)
      const body = response.body as any
      expect(body._tag).toBe('Raw')
      expect(body.body.expoFilePath).toBe('/data/scan.dcm')
      expect(body.body.start).toBe(0)
      expect(body.body.end).toBeUndefined()
    }).pipe(Effect.provide(platformLayer))

    await Effect.runPromise(program)
  })

  test('fileResponse sets weak ETag from size + mtime', async () => {
    stageFile('/data/asset.js', { size: 0x123, modificationTime: 0xabc })
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse('/data/asset.js')
      expect(response.headers['etag']).toBe('W/"123-abc"')
      expect(response.headers['last-modified']).toBe(new Date(0xabc).toUTCString())
    }).pipe(Effect.provide(platformLayer))

    await Effect.runPromise(program)
  })

  test('fileResponse omits Last-Modified when modificationTime is null', async () => {
    stageFile('/data/no-mtime.bin', { size: 16, modificationTime: null })
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse('/data/no-mtime.bin')
      expect(response.headers['etag']).toBe('W/"10-0"')
      expect(response.headers['last-modified']).toBeUndefined()
    }).pipe(Effect.provide(platformLayer))

    await Effect.runPromise(program)
  })

  test('fileResponse uses provided content-type and skips MIME inference', async () => {
    stageFile('/data/asset.html', { size: 1024 })
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse('/data/asset.html', {
        headers: Headers.fromInput({ 'content-type': 'application/octet-stream' }),
      })
      expect(response.headers['content-type']).toBe('application/octet-stream')
    }).pipe(Effect.provide(platformLayer))

    await Effect.runPromise(program)
  })

  test('fileResponse infers Content-Type into response.headers from path extension', async () => {
    stageFile('/cache/wildflower-static/index.html', { size: 1024 })
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse('/cache/wildflower-static/index.html')
      // Content-Type must live on response.headers, not just body.contentType,
      // because the Expo native file-response path forwards only the headers.
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    }).pipe(Effect.provide(platformLayer))

    await Effect.runPromise(program)
  })

  test('fileResponse falls back to application/octet-stream when extension is unknown', async () => {
    stageFile('/data/file.bin', { size: 1024 })
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse('/data/file.bin')
      // ServerResponseImpl copies body.contentType onto response.headers, so
      // file responses always carry a Content-Type even with an unknown ext.
      expect(response.headers['content-type']).toBe('application/octet-stream')
    }).pipe(Effect.provide(platformLayer))

    await Effect.runPromise(program)
  })

  test('fileResponse preserves byte range (offset + bytesToRead)', async () => {
    stageFile('/data/large.dcm', { size: 4096 })
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
    }).pipe(Effect.provide(platformLayer))

    await Effect.runPromise(program)
  })

  test('fileResponse fails with NotFound SystemError when the file is missing', async () => {
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      yield* platform.fileResponse('/data/missing.bin')
    }).pipe(Effect.provide(platformLayer))

    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failures = Array.from(Cause.failures(exit.cause))
      expect(failures.length).toBeGreaterThan(0)
      const firstFailure = failures[0] as any
      expect(firstFailure._tag).toBe('SystemError')
      expect(firstFailure.reason).toBe('NotFound')
      expect(firstFailure.pathOrDescriptor).toBe('/data/missing.bin')
    }
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
    }).pipe(Effect.provide(platformLayer))

    await Effect.runPromise(program)
  })
})
