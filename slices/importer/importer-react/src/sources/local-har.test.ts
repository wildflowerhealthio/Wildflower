import { Either } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { acceptLocalHar, REJECTION_MESSAGE, type ReadableFile } from './local-har.ts'

/**
 * `acceptLocalHar` is the gate every local pick passes: it reads the file and
 * validates it through `web-trace-core`'s own HAR parser, so a file the picker
 * accepts is one a replay can parse and a file it rejects is rejected here rather
 * than downstream.
 */

/** A minimal but complete HAR 1.2 archive, the JSON a network panel exports. */
const VALID_HAR = JSON.stringify({
  log: {
    version: '1.2',
    creator: { name: 'WebInspector', version: '537.36' },
    entries: [
      {
        startedDateTime: '2026-08-13T10:00:00.000Z',
        request: { method: 'GET', url: 'https://portal.example.org/api/v2/patients' },
        response: { status: 200, content: { size: 0, mimeType: 'application/json' } },
      },
    ],
  },
})

/** A file that reads back `text`, without constructing a DOM `File`. */
const fileOf = (name: string, text: string): ReadableFile => ({
  name,
  text: (): Promise<string> => Promise.resolve(text),
})

describe('acceptLocalHar', () => {
  it('should accept a valid HAR and carry its name and text onto a local pick', async () => {
    // Act
    const result = await acceptLocalHar(fileOf('portal-session.har', VALID_HAR))

    // Assert
    if (Either.isLeft(result)) throw new Error('expected an accepted pick')
    expect(result.right.fileName).toBe('portal-session.har')
    expect(result.right.text).toBe(VALID_HAR)
    expect(result.right.source).toEqual({ _tag: 'local' })
  })

  it('should reject a file that is not JSON at all', async () => {
    // Act
    const result = await acceptLocalHar(fileOf('notes.txt', 'this is not a HAR'))

    // Assert — rejected here, with a message about the format rather than a parser path
    if (Either.isRight(result)) throw new Error('expected a rejection')
    expect(result.left).toBe(REJECTION_MESSAGE)
  })

  it('should reject JSON that is not a HAR', async () => {
    // Act — valid JSON, but nothing a HAR reader can use
    const result = await acceptLocalHar(fileOf('data.json', JSON.stringify({ foo: 1 })))

    // Assert
    if (Either.isRight(result)) throw new Error('expected a rejection')
    expect(result.left).toBe(REJECTION_MESSAGE)
  })

  it('should preserve any file name and the exact text of an accepted HAR', async () => {
    // A validated pick is a gate, not a transform: whatever name and bytes came
    // in come back out unchanged, so the replay parses exactly what was picked.
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }).filter((n) => n.trim() !== ''),
        async (name) => {
          const result = await acceptLocalHar(fileOf(name, VALID_HAR))
          if (Either.isLeft(result)) throw new Error('expected an accepted pick')
          expect(result.right.fileName).toBe(name)
          expect(result.right.text).toBe(VALID_HAR)
        }
      )
    )
  })
})
