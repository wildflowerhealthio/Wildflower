import * as Headers from '@effect/platform/Headers'
import type * as HttpBody from '@effect/platform/HttpBody'
import * as HttpPlatform from '@effect/platform/HttpPlatform'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { pipe } from 'effect/Function'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as fc from 'fast-check'

// Stub the TurboModule so Jest can resolve the module graph; nothing in this test file calls into the native side.
jest.mock('../ExpoEffectPlatformModule', () => ({
  __esModule: true,
  default: {},
}))

// jest.mock is hoisted above imports, so per-test state lives on this module-level map (reset in beforeEach).
type MockEntry = { exists: boolean; size: number; modificationTime: number | null }
const MOCK_FS = new Map<string, MockEntry>()

jest.mock('expo-file-system', () => {
  class MockFile {
    private readonly uri: string
    constructor(uri: string) {
      // Production code only constructs `File` with a single URI string.
      this.uri = uri
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
import type { ExpoFileBody } from '../internal/httpServer.ts'

// `require` (not `import`) matches sibling test files where mock factories
// capture module-local variables that ES imports would race against.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const { make } = require('../internal/httpPlatform') as typeof HttpPlatformModule

const platformLayer = Layer.succeed(HttpPlatform.HttpPlatform, make)

const isExpoFileBody = (value: unknown): value is ExpoFileBody =>
  typeof value === 'object' && value !== null && 'expoFilePath' in value

const isString = (value: unknown): value is string => typeof value === 'string'

const expectRawBody = <B>(body: HttpBody.HttpBody, guard: (value: unknown) => value is B): B => {
  expect(body._tag).toBe('Raw')
  if (body._tag !== 'Raw') throw new Error(`expected Raw body, got ${body._tag}`)
  if (!guard(body.body)) throw new Error('Raw body did not match expected shape')
  return body.body
}

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

const runWithStage = <A, E>(
  stage: { path: string; size: number; modificationTime?: number | null } | null,
  body: (platform: HttpPlatform.HttpPlatform) => Effect.Effect<A, E>
): Promise<A> => {
  if (stage) stageFile(stage.path, stage)
  const program = Effect.gen(function* () {
    const platform = yield* HttpPlatform.HttpPlatform
    return yield* body(platform)
  }).pipe(Effect.provide(platformLayer))
  return Effect.runPromise(program)
}

beforeEach(() => {
  MOCK_FS.clear()
})

// ---------------------------------------------------------------------------
// Tests: ExpoHttpPlatform
// ---------------------------------------------------------------------------

describe('ExpoHttpPlatform', () => {
  test('fileResponse creates Raw body with ExpoFileBody sentinel', async () => {
    await runWithStage(
      { path: '/data/scan.dcm', size: 2048, modificationTime: 1_700_000_000_000 },
      (platform) =>
        Effect.gen(function* () {
          const response = yield* platform.fileResponse('/data/scan.dcm', {
            status: 200,
            headers: Headers.fromInput({ 'content-type': 'application/dicom' }),
          })
          expect(response.status).toBe(200)
          const sentinel = expectRawBody(response.body, isExpoFileBody)
          expect(sentinel.expoFilePath).toBe('/data/scan.dcm')
          expect(sentinel.start).toBe(0)
          expect(sentinel.end).toBeUndefined()
        })
    )
  })

  test('fileResponse sets weak ETag from size + mtime', async () => {
    await runWithStage(
      { path: '/data/asset.js', size: 0x123, modificationTime: 0xabc },
      (platform) =>
        Effect.gen(function* () {
          const response = yield* platform.fileResponse('/data/asset.js')
          expect(response.headers['etag']).toBe('W/"123-abc"')
          expect(response.headers['last-modified']).toBe(new Date(0xabc).toUTCString())
        })
    )
  })

  test('fileResponse omits Last-Modified when modificationTime is null', async () => {
    await runWithStage(
      { path: '/data/no-mtime.bin', size: 16, modificationTime: null },
      (platform) =>
        Effect.gen(function* () {
          const response = yield* platform.fileResponse('/data/no-mtime.bin')
          expect(response.headers['etag']).toBe('W/"10-0"')
          expect(response.headers['last-modified']).toBeUndefined()
        })
    )
  })

  test('fileResponse ETag/Last-Modified formula (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 0xffffffff }),
        fc.option(fc.nat({ max: 0xffffffff }), { nil: null }),
        async (size, modificationTime) => {
          const path = '/data/prop.bin'
          MOCK_FS.clear()
          await runWithStage({ path, size, modificationTime }, (platform) =>
            Effect.gen(function* () {
              const response = yield* platform.fileResponse(path)
              const mtimeHex = (modificationTime ?? 0).toString(16)
              expect(response.headers['etag']).toBe(`W/"${size.toString(16)}-${mtimeHex}"`)
              if (modificationTime !== null) {
                expect(response.headers['last-modified']).toBe(
                  new Date(modificationTime).toUTCString()
                )
              } else {
                expect(response.headers['last-modified']).toBeUndefined()
              }
            })
          )
        }
      ),
      { numRuns: 50 }
    )
  })

  test.each([
    {
      label: 'provided content-type wins over MIME inference',
      path: '/data/asset.html',
      providedContentType: 'application/octet-stream',
      expectedContentType: 'application/octet-stream',
    },
    {
      label: 'inferred from extension when no header is supplied',
      path: '/cache/wildflower-static/index.html',
      providedContentType: undefined,
      expectedContentType: 'text/html; charset=utf-8',
    },
    {
      label: 'falls back to application/octet-stream for unknown extensions',
      path: '/data/file.bin',
      providedContentType: undefined,
      expectedContentType: 'application/octet-stream',
    },
  ])(
    'fileResponse Content-Type: $label',
    async ({ path, providedContentType, expectedContentType }) => {
      await runWithStage({ path, size: 1024 }, (platform) =>
        Effect.gen(function* () {
          const response = yield* platform.fileResponse(
            path,
            providedContentType
              ? { headers: Headers.fromInput({ 'content-type': providedContentType }) }
              : undefined
          )
          expect(response.headers['content-type']).toBe(expectedContentType)
        })
      )
    }
  )

  test('fileResponse preserves byte range (offset + bytesToRead)', async () => {
    await runWithStage({ path: '/data/large.dcm', size: 4096 }, (platform) =>
      Effect.gen(function* () {
        const response = yield* platform.fileResponse('/data/large.dcm', {
          status: 206,
          offset: 1024,
          bytesToRead: 512,
        })
        expect(response.status).toBe(206)
        const sentinel = expectRawBody(response.body, isExpoFileBody)
        expect(sentinel.start).toBe(1024)
        expect(sentinel.end).toBe(1536) // start + bytesToRead
      })
    )
  })

  test('fileResponse fails with NotFound SystemError when the file is missing', async () => {
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      yield* platform.fileResponse('/data/missing.bin')
    }).pipe(Effect.provide(platformLayer))

    const exit = await Effect.runPromiseExit(program)
    const error = pipe(
      exit,
      Exit.causeOption,
      Option.flatMap(Cause.failureOption),
      Option.getOrThrow
    )
    expect(error).toMatchObject({
      _tag: 'SystemError',
      reason: 'NotFound',
      pathOrDescriptor: '/data/missing.bin',
    })
  })

  test('fileWebResponse returns 501 Not Implemented', async () => {
    const program = Effect.gen(function* () {
      const platform = yield* HttpPlatform.HttpPlatform
      const file: HttpBody.HttpBody.FileLike = {
        name: 'test.bin',
        size: 100,
        type: 'application/octet-stream',
        lastModified: Date.now(),
        stream: () => null,
      }
      const response = yield* platform.fileWebResponse(file)
      expect(response.status).toBe(501)
      const body = expectRawBody(response.body, isString)
      expect(body).toContain('not supported')
    }).pipe(Effect.provide(platformLayer))

    await Effect.runPromise(program)
  })
})
